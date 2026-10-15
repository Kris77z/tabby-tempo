import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import engine
from transaction import DeployError


class EngineTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.project = self.root / 'project'
        self.store = self.root / 'store'
        self.build = self.root / 'build'
        for p in [self.project, self.store, self.build]: p.mkdir()
        self.old = self.artifact('1' * 40, {'keep.txt': 'old', 'old-only.txt': 'original'})
        self.new = self.artifact('2' * 40, {'keep.txt': 'new', 'new-only.txt': 'candidate'})
        for name, content in {'keep.txt': 'old', 'old-only.txt': 'original', 'private.txt': 'PRIVATE'}.items():
            (self.project / name).write_text(content)
        (self.project / 'contracts/out').mkdir(parents=True)
        (self.project / 'contracts/out/manual.json').write_text('ARTIFACT')
        (self.project / '.data').mkdir()
        (self.project / '.data/journal').write_text('JOURNAL')
        self.adapter = engine.Production.__new__(engine.Production)
        self.adapter.project = self.project
        self.adapter.store = self.store
        self.adapter.current = self.old
        self.adapter.previous = self.old
        self.adapter.controlled_paths = {e['path'] for e in self.old['files']}
        self.adapter.maintenance_token = None
        self.adapter.log = self.store / 'test.log'
        self.account = patch.object(engine.pwd, 'getpwnam', return_value=types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid()))
        self.account.start()
        self.addCleanup(self.account.stop)

    def artifact(self, sha, content):
        source = self.root / sha
        source.mkdir()
        entries = []
        for name, value in content.items():
            path = source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value)
            entries.append({'path': name, 'sha256': engine.digest(path), 'mode': 0o644})
        artifact = self.store / (sha + '.tar.gz')
        with tarfile.open(artifact, 'w:gz') as tar:
            for name in content: tar.add(source / name, arcname=name, recursive=False)
        return {'sha': sha, 'files': entries, 'buildId': sha[:8], 'artifact': str(artifact), 'artifactSha256': engine.digest(artifact)}

    def preserved(self):
        self.assertEqual((self.project / '.data/journal').read_text(), 'JOURNAL')
        self.assertEqual((self.project / 'contracts/out/manual.json').read_text(), 'ARTIFACT')
        self.assertEqual((self.project / 'private.txt').read_text(), 'PRIVATE')
        self.assertFalse(list(self.store.glob('unpack-*')))

    def restored(self):
        self.assertEqual((self.project / 'keep.txt').read_text(), 'old')
        self.assertEqual((self.project / 'old-only.txt').read_text(), 'original')
        self.assertFalse((self.project / 'new-only.txt').exists())
        self.preserved()

    def test_partial_copy_failure_removes_new_paths_on_rollback(self):
        original = shutil.copyfile
        def injected(src, dst, *args, **kwargs):
            result = original(src, dst, *args, **kwargs)
            if Path(dst).name == 'new-only.txt': raise OSError('after candidate write')
            return result
        with patch.object(engine.shutil, 'copyfile', side_effect=injected):
            with self.assertRaises(OSError): self.adapter.activate(self.new)
        self.adapter.restore_code_and_build(self.old)
        self.restored()

    def test_partial_delete_failure_restores_old_only_without_collision(self):
        original = Path.unlink
        def injected(path, *args, **kwargs):
            if path == self.project / 'old-only.txt': raise OSError('before original deletion')
            return original(path, *args, **kwargs)
        with patch.object(Path, 'unlink', injected):
            with self.assertRaises(OSError): self.adapter.activate(self.new)
        self.adapter.restore_code_and_build(self.old)
        self.restored()

    def test_unowned_collision_rejected_before_any_mutation(self):
        (self.project / 'new-only.txt').write_text('OPERATOR')
        with self.assertRaises(DeployError) as error: self.adapter.activate(self.new)
        self.assertEqual(error.exception.code, 'TRACKED_UNOWNED_COLLISION')
        self.assertEqual((self.project / 'keep.txt').read_text(), 'old')
        self.assertEqual((self.project / 'new-only.txt').read_text(), 'OPERATOR')
        self.preserved()

    def test_persistent_record_restored_after_partial_commit(self):
        engine.write_json(self.store / 'current.json', self.new)
        self.adapter.finish_rollback(self.old)
        self.assertEqual(json.loads((self.store / 'current.json').read_text())['sha'], self.old['sha'])

    def test_nested_tracked_parents_are_app_owned_0755_under_worker_umask(self):
        candidate = self.artifact('3' * 40, {'keep.txt': 'next', 'services/hosted-agents/src/external/registry.ts': 'export const ready = true;'})
        changes = []
        # Spy through the original function, avoiding any fake filesystem modes.
        chown = os.fchown
        def owned(fd, uid, gid):
            changes.append((os.fstat(fd).st_ino, uid, gid))
            chown(fd, uid, gid)
        previous_mask = os.umask(0o077)
        try:
            with patch.object(engine.os, 'fchown', side_effect=owned):
                self.adapter.activate(candidate)
        finally: os.umask(previous_mask)
        parent = self.project / 'services/hosted-agents/src/external'
        for path in [parent, *parent.parents]:
            if path == self.project: break
            meta = path.stat()
            self.assertEqual(stat.S_IMODE(meta.st_mode), 0o755)
            self.assertEqual((meta.st_uid, meta.st_gid), (os.getuid(), os.getgid()))
            self.assertIn((meta.st_ino, os.getuid(), os.getgid()), changes)
        self.assertEqual((parent / 'registry.ts').read_text(), 'export const ready = true;')
        self.preserved()

    def root_remnant(self, relative):
        """Real 0700 directory; fake only its root UID/GID on non-root CI hosts."""
        path = self.project / relative
        path.mkdir(parents=True)
        path.chmod(0o700)
        inode = (path.stat().st_dev, path.stat().st_ino)
        lstat, fstat = Path.lstat, os.fstat
        def root(meta):
            if (meta.st_dev, meta.st_ino) != inode: return meta
            values = list(meta); values[4] = 0; values[5] = 0
            return os.stat_result(values)
        def observed(value, *args, **kwargs): return root(lstat(value, *args, **kwargs))
        return path, patch.object(Path, 'lstat', observed), patch.object(engine.os, 'fstat', side_effect=lambda fd: root(fstat(fd)))

    def test_empty_candidate_only_root_0700_remnant_repaired(self):
        candidate = self.artifact('3' * 40, {'keep.txt': 'next', 'services/hosted-agents/src/external/registry.ts': 'PUBLIC'})
        path, owner, fd_owner = self.root_remnant('services/hosted-agents/src/external')
        with owner, fd_owner: self.adapter.activate(candidate)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o755)
        self.assertEqual((path / 'registry.ts').read_text(), 'PUBLIC')
        self.preserved()

    def test_remnant_with_exact_candidate_source_is_repaired(self):
        candidate = self.artifact('3' * 40, {'keep.txt': 'next', 'services/hosted-agents/src/external/registry.ts': 'PUBLIC'})
        path, owner, fd_owner = self.root_remnant('services/hosted-agents/src/external')
        (path / 'registry.ts').write_text('PUBLIC')
        # This candidate path was installed by the interrupted activation.
        self.adapter.controlled_paths.add('services/hosted-agents/src/external/registry.ts')
        with owner, fd_owner: self.adapter.activate(candidate)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o755)
        self.preserved()

    def test_root_remnant_with_private_or_changed_contents_refused_before_mutation(self):
        for filename, content in [('private-token', 'PRIVATE'), ('registry.ts', 'PRIVATE')]:
            with self.subTest(filename=filename):
                candidate = self.artifact(('4' if filename == 'private-token' else '5') * 40, {'keep.txt': 'next', 'frontend/acceptance/new/registry.ts': 'PUBLIC'})
                path, owner, fd_owner = self.root_remnant('frontend/acceptance/new')
                (path / filename).write_text(content)
                self.adapter.controlled_paths.add('frontend/acceptance/new/registry.ts')
                with owner, fd_owner:
                    with self.assertRaises(DeployError) as error: self.adapter.activate(candidate)
                self.assertEqual(error.exception.code, 'RELEASE_PARENT_UNOWNED')
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
                self.assertEqual((path / filename).read_text(), 'PRIVATE')
                self.assertEqual((self.project / 'keep.txt').read_text(), 'old')
                shutil.rmtree(self.project / 'frontend')
                self.preserved()

    def test_previous_parent_and_unrelated_private_directory_are_never_normalized(self):
        old = self.artifact('6' * 40, {'services/keep.txt': 'old'})
        candidate = self.artifact('7' * 40, {'services/keep.txt': 'next'})
        path, owner, fd_owner = self.root_remnant('services')
        (path / 'keep.txt').write_text('old')
        self.adapter.current = old; self.adapter.controlled_paths = {'services/keep.txt'}
        private = self.project / '.data'; private.chmod(0o700)
        with owner, fd_owner, patch.object(engine.pwd, 'getpwnam', return_value=types.SimpleNamespace(pw_uid=65534, pw_gid=65534)):
            with self.assertRaises(DeployError) as error: self.adapter.activate(candidate)
        self.assertEqual(error.exception.code, 'RELEASE_PARENT_INACCESSIBLE')
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o700)
        self.assertEqual((path / 'keep.txt').read_text(), 'old')

    def test_candidate_parent_symlink_and_unowned_nested_directory_refused(self):
        candidate = self.artifact('3' * 40, {'keep.txt': 'next', 'services/new/registry.ts': 'PUBLIC'})
        (self.project / 'services').symlink_to(self.store, target_is_directory=True)
        with self.assertRaises(DeployError) as error: self.adapter.activate(candidate)
        self.assertEqual(error.exception.code, 'RELEASE_DESTINATION_SYMLINK')
        (self.project / 'services').unlink()
        path, owner, fd_owner = self.root_remnant('services/new')
        (path / 'private').mkdir()
        with owner, fd_owner:
            with self.assertRaises(DeployError) as error: self.adapter.activate(candidate)
        self.assertEqual(error.exception.code, 'RELEASE_PARENT_UNOWNED')
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
        self.assertEqual((self.project / 'keep.txt').read_text(), 'old')

    def test_reset_failed_is_one_fixed_three_unit_command(self):
        with patch.object(engine, 'run', return_value=b'') as command:
            self.adapter.reset_failed()
        command.assert_called_once_with(['/usr/bin/systemctl', 'reset-failed', *engine.UNITS], log=self.adapter.log)

    def test_failure_record_and_worker_receipt_keep_only_fixed_error_details(self):
        details = {'originalCode': 'RUNTIME_CHILD_MISSING', 'originalPhase': 'HEALTH', 'rollbackCode': 'DEPLOY_COMMAND_FAILED', 'rollbackPhase': 'START'}
        self.adapter.record_failure('ROLLBACK_FAILED_SERVICES_STOPPED', self.new['sha'], **details, exception='PRIVATE RPC', traceback='PRIVATE RAW')
        failure = json.loads((self.store / 'last-failure.json').read_text())
        for key, value in details.items(): self.assertEqual(failure[key], value)
        self.assertNotIn('PRIVATE', json.dumps(failure))
        request_id = 'a' * 32
        with patch.object(engine, 'STORE', self.store), patch.object(engine, 'Production', return_value=self.adapter), patch.object(engine, 'execute', side_effect=DeployError('ROLLBACK_FAILED_SERVICES_STOPPED', **details)), patch.object(engine.signal, 'signal'):
            with self.assertRaises(DeployError): engine.worker('release', self.new['sha'], request_id)
        receipt = json.loads((self.store / 'requests' / (request_id + '.json')).read_text())
        for key, value in details.items(): self.assertEqual(receipt[key], value)

    def test_stage_removed_after_build_exception(self):
        self.adapter.source = lambda sha: []
        self.adapter.build_stage = lambda *args: (_ for _ in ()).throw(DeployError('BUILD_FAILED'))
        with patch.object(engine, 'BUILD_ROOT', self.build), patch.object(engine, 'STORE', self.store):
            with self.assertRaises(DeployError): self.adapter.prepare('release', self.new['sha'])
        self.assertFalse(list(self.build.glob('stage-*')))

    def test_disk_budget_rejects_before_stage(self):
        usage = types.SimpleNamespace(free=100)
        with patch.object(engine.shutil, 'disk_usage', return_value=usage):
            with self.assertRaises(DeployError) as error: self.adapter.prepare('release', self.new['sha'])
        self.assertEqual(error.exception.code, 'DEPLOY_DISK_BUDGET_INSUFFICIENT')
        self.assertFalse(list(self.build.iterdir()))

    def test_existing_manual_maintenance_is_never_removed(self):
        flag = self.root / 'maintenance'
        flag.write_text('OPERATOR')
        with patch.object(engine, 'MAINTENANCE', flag):
            with self.assertRaises(DeployError): self.adapter.enter_maintenance()
            self.adapter.leave_maintenance()
        self.assertEqual(flag.read_text(), 'OPERATOR')

    def test_only_owned_maintenance_can_be_removed(self):
        flag = self.root / 'maintenance'
        with patch.object(engine, 'MAINTENANCE', flag), patch.object(engine, 'request', return_value=(503, b'')), patch.object(engine, 'run', return_value=b''):
            self.adapter.enter_maintenance()
            flag.write_text('OPERATOR_CHANGED')
            with self.assertRaises(DeployError): self.adapter.leave_maintenance()
        self.assertEqual(flag.read_text(), 'OPERATOR_CHANGED')

    def test_path_and_symlink_protection(self):
        for path in ['/tmp/escape', '../escape', 'foo/../escape', '.data/journal', 'contracts/../.data/journal', '.env', 'operator.key', 'frontend/.next/BUILD_ID']:
            with self.subTest(path=path), self.assertRaises(DeployError): engine.safe_path(path)
        (self.project / 'escape').symlink_to(self.store, target_is_directory=True)
        with self.assertRaises(DeployError): engine.destination(self.project, 'escape/file.txt')
        with self.assertRaises(DeployError): engine.check_links(self.project)

    def test_ssh_rejects_shell_scp_and_arbitrary_arguments(self):
        loader = importlib.machinery.SourceFileLoader('tempo_ssh_entry', str(ROOT / 'ssh-entry'))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        module = importlib.util.module_from_spec(spec)
        loader.exec_module(module)
        self.assertEqual(module.parse('release ' + 'a' * 40), ('release', 'a' * 40))
        for value in [None, '', 'id', 'bash', 'scp -t /tmp/a', 'release main', 'release ' + 'A' * 40, 'release ' + 'a' * 40 + ';id', 'rollback ' + 'a' * 40 + '\n']:
            with self.assertRaises(ValueError): module.parse(value)


if __name__ == '__main__': unittest.main()
