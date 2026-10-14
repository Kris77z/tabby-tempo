#!/usr/bin/python3 -I
"""Root-owned fixed-host deployer. Application releases never update this copy."""
from __future__ import annotations

import contextlib
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import signal
import shutil
import stat
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from state_guard import capture, compare, require_quiescent, StateError
from transaction import execute, DeployError

PROJECT = Path('/Users/jungle/Desktop/dev/agentfuel-tempo')
STORE = Path('/var/lib/tabby-tempo-cicd')
BUILD_ROOT = Path('/var/lib/tabby-tempo-build')
REPO = 'https://github.com/Kris77z/tabby-tempo.git'
ORIGIN = 'https://tempo.tabbyai.xyz'
NODE = '/opt/tabby-tempo/node/bin/node'
BUILD_USER = 'tabby-tempo-build'
APP_USER = 'tabby-tempo'
MAINTENANCE = Path('/run/tabby-tempo-cicd/maintenance')
UNITS = ['tabby-tempo-frontend.service', 'tabby-tempo-runtime.service', 'tabby-tempo-gateway.service']
SHA = re.compile(r'[0-9a-f]{40}\Z')
GENERATED = {'frontend/next-env.d.ts'}
SAFE_ENV = {'FRONTEND_RPC_TRANSPORT', 'HOSTED_AGENTS_URL', 'HOSTED_FRONTEND_ORIGIN',
            'HOSTED_FRONTEND_TRUST_PROXY', 'AGENTFUEL_RPC_INTERVAL_MS',
            'AGENTFUEL_RPC_CALL_GAS_LIMIT', 'AGENTFUEL_RPC_RETRY_READ_503'}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.tmp-' + uuid.uuid4().hex)
    with temporary.open('x') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def safe_path(value):
    path = PurePosixPath(value)
    if not value or str(path) != value or path.is_absolute() or any(p in {'', '.', '..'} for p in path.parts):
        raise DeployError('RELEASE_PATH_INVALID')
    if any(p in {'.git', '.data', 'node_modules', '__pycache__'} or p.startswith('.next') for p in path.parts):
        raise DeployError('RELEASE_PATH_PROTECTED')
    if path.name in {'.env', 'AGENTS.md', 'CLAUDE.md'} or path.suffix in {'.key', '.pem', '.p12', '.pyc'}:
        raise DeployError('RELEASE_PATH_PROTECTED')
    if path.name.startswith('.env.') and path.name not in {'.env.example', '.env.monad-testnet.example'}:
        raise DeployError('RELEASE_PATH_PROTECTED')
    return path


def destination(root, name):
    path = root.joinpath(*safe_path(name).parts)
    current = root
    if root.is_symlink() or root.resolve() != root:
        raise DeployError('PROJECT_PATH_INVALID')
    for part in path.relative_to(root).parts:
        current = current / part
        if current.is_symlink():
            raise DeployError('RELEASE_DESTINATION_SYMLINK')
    return path


def run(args, *, cwd=None, timeout=120, log=None):
    env = {'PATH': '/opt/tabby-tempo/node/bin:/usr/sbin:/usr/bin:/sbin:/bin',
           'HOME': '/root', 'LANG': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1',
           'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0'}
    result = subprocess.run(args, cwd=cwd, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=timeout)
    if log:
        with Path(log).open('ab') as stream:
            os.chmod(log, 0o600)
            stream.write(result.stdout)
    if result.returncode:
        # Detailed build/RPC output stays in the root-only journal, never SSH stdout.
        raise DeployError('DEPLOY_COMMAND_FAILED')
    return result.stdout


def request(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return response.status, response.read(2_000_000)
    except urllib.error.HTTPError as error:
        return error.code, error.read(100_000)


def check_links(root):
    for path in root.rglob('*'):
        if path.is_symlink() and not path.resolve().is_relative_to(root):
            raise DeployError('DEPENDENCY_SYMLINK_ESCAPE')


def tree_files(root):
    files = []
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            files.append({'path': str(path.relative_to(root)), 'link': os.readlink(path)})
        elif path.is_file():
            files.append({'path': str(path.relative_to(root)), 'sha256': digest(path)})
    return hashlib.sha256(json.dumps(files, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


class Production:
    def __init__(self):
        self.project = PROJECT
        self.store = STORE
        self.repo = STORE / 'repo.git'
        self.log = STORE / 'logs' / (time.strftime('%Y%m%dT%H%M%S') + '-' + uuid.uuid4().hex + '.log')
        self.log.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.current = json.loads((STORE / 'current.json').read_text())
        self.previous = self.current
        self.operation = None
        self.maintenance_token = None
        self.controlled_paths = {entry['path'] for entry in self.current['files']}

    @contextlib.contextmanager
    def lock(self):
        lock = self.store / 'deploy.lock'
        with lock.open('a') as stream:
            os.chmod(lock, 0o600)
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise DeployError('DEPLOYMENT_BUSY') from None
            yield

    def git(self, *args):
        return run(['/usr/bin/git', '--git-dir=' + str(self.repo), *args],
                   log=None if args[:1] == ('cat-file',) else self.log)

    def source(self, sha):
        entries = []
        for entry in self.git('ls-tree', '-r', '-z', sha).split(b'\0'):
            if not entry:
                continue
            meta, raw_path = entry.split(b'\t', 1)
            mode, kind, blob = meta.decode().split()
            path = raw_path.decode('utf-8')
            safe_path(path)
            if kind != 'blob' or mode not in {'100644', '100755'}:
                raise DeployError('RELEASE_LINK_OR_SUBMODULE')
            content = self.git('cat-file', 'blob', blob)
            entries.append({'path': path, 'sha256': hashlib.sha256(content).hexdigest(),
                            'mode': 0o755 if mode == '100755' else 0o644})
        return entries

    def verify_source(self, entries, root, generated=False):
        for entry in entries:
            path = destination(root, entry['path'])
            if not path.is_file() or (digest(path) != entry['sha256'] and not (generated and entry['path'] in GENERATED)):
                raise DeployError('SOURCE_HASH_MISMATCH')

    def validate_request(self, operation, sha):
        if operation not in {'release', 'rollback'} or not SHA.fullmatch(sha):
            raise DeployError('DEPLOY_COMMAND_INVALID')
        if self.project.resolve() != PROJECT or self.project.is_symlink() or not Path('/srv/tabby-tempo').is_symlink() or Path('/srv/tabby-tempo').resolve() != PROJECT:
            raise DeployError('PROJECT_PATH_INVALID')
        run(['/usr/bin/git', '--git-dir=' + str(self.repo), 'fetch', '--no-tags', REPO,
             '+refs/heads/main:refs/heads/main'], timeout=180, log=self.log)
        main = self.git('rev-parse', 'refs/heads/main').decode().strip()
        if operation == 'release' and main != sha:
            raise DeployError('RELEASE_NOT_CURRENT_MAIN')
        if operation == 'rollback' and not (self.store / 'successful' / (sha + '.json')).is_file():
            raise DeployError('ROLLBACK_NOT_PREVIOUS_SUCCESS')
        self.git('merge-base', '--is-ancestor', sha, 'refs/heads/main')
        self.verify_source(self.current['files'], self.project)
        # Solidity binaries and deployed addresses need a separate explicit migration.
        target = {e['path']: e['sha256'] for e in self.source(sha) if e['path'].startswith('contracts/src/')}
        current = {e['path']: e['sha256'] for e in self.current['files'] if e['path'].startswith('contracts/src/')}
        if target != current:
            raise DeployError('CONTRACT_SOURCE_CHANGE_REQUIRES_OPERATOR')
        owned = {e['path'] for e in self.current['files']}
        for entry in self.source(sha):
            path = destination(self.project, entry['path'])
            if entry['path'] not in owned and path.exists():
                raise DeployError('TRACKED_UNOWNED_COLLISION')
        self.operation = operation

    def capture(self):
        view = capture(self.project)
        view['operationalFiles'] = {str(path): digest(path) for path in
            [Path('/etc/tabby-tempo/' + n + '.env') for n in ['frontend', 'runtime', 'gateway']] +
            [Path('/etc/systemd/system') / unit for unit in UNITS]}
        view['contractArtifacts'] = tree_files(self.project / 'contracts/out')
        return view

    require_quiescent = staticmethod(require_quiescent)

    def compare(self, before, after, phase):
        if before['operationalFiles'] != after['operationalFiles'] or before['contractArtifacts'] != after['contractArtifacts']:
            raise DeployError('OPERATIONAL_STATE_CHANGED')
        return compare(before, after, phase)

    def stage_run(self, stage, arguments, name, network=False, extra_env=None):
        env = {'PATH': '/opt/tabby-tempo/node/bin:/usr/bin:/bin', 'HOME': str(BUILD_ROOT),
               'NODE_ENV': 'production', 'NEXT_TELEMETRY_DISABLED': '1',
               'CI': 'true', **(extra_env or {})}
        unit = 'tabby-tempo-build-' + uuid.uuid4().hex
        args = ['/usr/bin/systemd-run', '--quiet', '--wait', '--pipe', '--collect',
                '--unit=' + unit,
                '-p', 'User=' + BUILD_USER, '-p', 'Group=' + BUILD_USER,
                '-p', 'WorkingDirectory=' + str(stage), '-p', 'ProtectSystem=strict',
                '-p', 'ProtectHome=true', '-p', 'PrivateTmp=true', '-p', 'NoNewPrivileges=true',
                '-p', 'PrivateNetwork=' + ('false' if network else 'true'),
                '-p', 'ReadWritePaths=' + str(stage) + ' ' + str(BUILD_ROOT),
                '-p', 'InaccessiblePaths=' + str(PROJECT / '.data') + ' /etc/tabby-tempo ' + str(STORE),
                '-p', 'TimeoutStartSec=30', '-p', 'RuntimeMaxSec=900',
                '-p', 'TimeoutStopSec=30', '-p', 'KillMode=control-group', '-p', 'UMask=0077',
                '-p', 'MemoryMax=3G', '-p', 'CPUQuota=200%', '-p', 'TasksMax=256']
        for key, value in env.items():
            args += ['-E', key + '=' + value]
        complete = False
        try:
            run([*args, *arguments], timeout=960, log=self.log)
            complete = True
        finally:
            if not complete:
                # A timed-out/disconnected systemd-run client does not own the
                # build process. Stop its PID1 unit before removing the stage.
                try: run(['/usr/bin/systemctl', 'stop', unit], timeout=45, log=self.log)
                except Exception: pass

    def prepare(self, operation, sha):
        if shutil.disk_usage(BUILD_ROOT).free < 4 * 1024 ** 3 or shutil.disk_usage(STORE).free < 4 * 1024 ** 3:
            raise DeployError('DEPLOY_DISK_BUDGET_INSUFFICIENT')
        if operation == 'rollback':
            saved = json.loads((self.store / 'successful' / (sha + '.json')).read_text())
            artifact = Path(saved['artifact'])
            if not artifact.is_relative_to(self.store / 'artifacts') or not artifact.is_file() or digest(artifact) != saved['artifactSha256']:
                raise DeployError('ROLLBACK_ARTIFACT_INVALID')
            return {'sha': sha, 'files': saved['files'], 'buildId': saved['buildId'], 'artifact': str(artifact), 'artifactSha256': saved['artifactSha256']}
        entries = self.source(sha)
        stage = BUILD_ROOT / ('stage-' + sha + '-' + uuid.uuid4().hex)
        stage.mkdir(mode=0o700)
        try:
            return self.build_stage(stage, sha, entries)
        finally:
            shutil.rmtree(stage, ignore_errors=True)

    def build_stage(self, stage, sha, entries):
        archive = self.git('archive', '--format=tar', sha)
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            for member in tar:
                if member.isdir():
                    continue
                safe_path(member.name)
                if not member.isfile():
                    raise DeployError('RELEASE_LINK_OR_SUBMODULE')
                target = destination(stage, member.name)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(tar.extractfile(member).read())
                os.chmod(target, 0o755 if member.mode & 0o111 else 0o644)
        self.verify_source(entries, stage)
        build_account = pwd.getpwnam(BUILD_USER)
        for path in [stage, *stage.rglob('*')]:
            os.chown(path, build_account.pw_uid, build_account.pw_gid)
        # Production credentials are never in this environment or stage. Only
        # the public deployment manifest and an empty build-only freeplay path.
        original = {}
        for line in Path('/etc/tabby-tempo/frontend.env').read_text().splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                key, value = line.split('=', 1)
                original[key] = value.strip('"\'')
        if original.get('FRONTEND_MODE') != 'chain' or original.get('HOSTED_FRONTEND_ORIGIN') != ORIGIN or original.get('NEXT_DIST_DIR', '.next') != '.next':
            raise DeployError('PRODUCTION_FRONTEND_DOMAIN_INVALID')
        public_manifest = stage / 'deployment-public.json'
        deployment = json.loads(Path(original['FRONTEND_MANIFEST_PATH']).read_text())
        for key in ['rpcUrl', 'underwriterUrl', 'arenaUrl', 'explorerUrl']:
            if deployment.get(key) and ('@' in deployment[key] or '?' in deployment[key]):
                raise DeployError('BUILD_MANIFEST_PRIVATE_URL')
        public_manifest.write_text(json.dumps(deployment) + '\n')
        os.chown(public_manifest, build_account.pw_uid, build_account.pw_gid)
        self.stage_run(stage, [NODE, '/opt/tabby-tempo/node/lib/node_modules/npm/bin/npm-cli.js',
                       'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], 'dependencies', network=True)
        check_links(stage)
        modules = stage / 'node_modules'
        modules_before = tree_files(modules)
        env = {key: value for key, value in original.items() if key in SAFE_ENV}
        env.update({'FRONTEND_MODE': 'chain', 'FRONTEND_MANIFEST_PATH': str(public_manifest),
                    'NEXT_DIST_DIR': '.next', 'ARENA_PLAY_STATE_PATH': str(stage / 'arena-build.json')})
        self.stage_run(stage, [NODE, str(modules / 'next/dist/bin/next'), 'build', 'frontend', '--webpack'],
                       'frontend', extra_env=env)
        self.verify_source(entries, stage, generated=True)
        if tree_files(modules) != modules_before:
            raise DeployError('BUILD_CHANGED_DEPENDENCIES')
        self.stage_run(stage, [NODE, str(modules / 'typescript/bin/tsc'), '--noEmit'], 'types')
        self.stage_run(stage, [NODE, str(modules / 'typescript/bin/tsc'), '--noEmit', '--project', 'frontend/tsconfig.json'], 'frontend-types')
        dist = stage / 'frontend/.next'
        build_id = (dist / 'BUILD_ID').read_text().strip()
        artifact = self.store / 'artifacts' / (sha + '-' + uuid.uuid4().hex + '.tar.gz')
        artifact.parent.mkdir(mode=0o700, exist_ok=True)
        # Archive exact tracked files, dependencies and the Linux build only.
        # Ignored/private data and contracts/out never enter or leave this bundle.
        with tarfile.open(artifact, 'w:gz') as tar:
            for entry in entries:
                tar.add(stage / entry['path'], arcname=entry['path'], recursive=False)
            for path in ['node_modules', 'frontend/node_modules', 'frontend/.next']:
                if (stage / path).exists():
                    tar.add(stage / path, arcname=path)
        os.chmod(artifact, 0o600)
        final_entries = [{**entry, 'sha256': digest(stage / entry['path'])} for entry in entries]
        return {'sha': sha, 'files': final_entries, 'buildId': build_id, 'artifact': str(artifact), 'artifactSha256': digest(artifact)}

    def enter_maintenance(self):
        MAINTENANCE.parent.mkdir(mode=0o755, exist_ok=True)
        token = uuid.uuid4().hex
        try:
            with MAINTENANCE.open('x') as stream:
                stream.write(token + '\n')
        except FileExistsError:
            raise DeployError('MAINTENANCE_REQUIRES_OPERATOR') from None
        self.maintenance_token = token
        os.chmod(MAINTENANCE, 0o644)
        status, _ = request(ORIGIN + '/')
        if status != 503:
            raise DeployError('MAINTENANCE_NOT_EFFECTIVE')
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            sockets = run(['/usr/bin/ss', '-Htn', 'state', 'established',
                           '( sport = :3028 or dport = :3028 or sport = :8794 or dport = :8794 )'])
            if not sockets.strip():
                return
            time.sleep(1)
        raise DeployError('INGRESS_DRAIN_TIMEOUT')

    def leave_maintenance(self):
        if self.maintenance_token is None:
            return
        if not MAINTENANCE.is_file() or MAINTENANCE.read_text().strip() != self.maintenance_token:
            raise DeployError('MAINTENANCE_OWNERSHIP_CHANGED')
        MAINTENANCE.unlink()
        self.maintenance_token = None

    def wait_stable(self):
        time.sleep(3)

    def stop_all(self):
        run(['/usr/bin/systemctl', 'stop', *UNITS], timeout=150, log=self.log)
        for unit in UNITS:
            value = run(['/usr/bin/systemctl', 'show', unit, '-p', 'ActiveState', '--value']).decode().strip()
            if value not in {'inactive', 'failed'}:
                raise DeployError('WRITER_STILL_ACTIVE')
            group = run(['/usr/bin/systemctl', 'show', unit, '-p', 'ControlGroup', '--value']).decode().strip()
            if group:
                cgroup = Path('/sys/fs/cgroup') / group.lstrip('/')
                if any(path.read_text().strip() for path in cgroup.rglob('cgroup.procs')):
                    raise DeployError('WRITER_CHILD_STILL_ACTIVE')

    def start_all(self):
        for unit in reversed(UNITS):
            run(['/usr/bin/systemctl', 'start', unit], timeout=660, log=self.log)

    def artifact_current(self):
        artifact = self.store / 'artifacts' / (self.current['sha'] + '-backup-' + uuid.uuid4().hex + '.tar.gz')
        artifact.parent.mkdir(mode=0o700, exist_ok=True)
        with tarfile.open(artifact, 'w:gz') as tar:
            for entry in self.current['files']:
                tar.add(destination(self.project, entry['path']), arcname=entry['path'], recursive=False)
            for name in ['node_modules', 'frontend/node_modules', 'frontend/.next']:
                if (self.project / name).exists():
                    tar.add(self.project / name, arcname=name)
        os.chmod(artifact, 0o600)
        return {**self.current, 'artifact': str(artifact), 'artifactSha256': digest(artifact)}

    def backup(self, cold):
        self.verify_source(self.current['files'], self.project)
        folder = self.store / 'backups' / (time.strftime('%Y%m%dT%H%M%S') + '-' + uuid.uuid4().hex)
        folder.mkdir(parents=True, mode=0o700)
        previous = self.artifact_current()
        state_archive = folder / 'private-state.tar.gz'
        with tarfile.open(state_archive, 'w:gz') as tar:
            tar.add(self.project / '.data/tempo-20261012', arcname='tempo-20261012')
            # The guard rejects references outside this private state tree.
            # This backup is evidence only; automatic rollback never applies it.
        os.chmod(state_archive, 0o600)
        write_json(folder / 'cold.json', cold)
        write_json(folder / 'backup.json', {'previous': previous, 'privateStateArchiveSha256': digest(state_archive), 'restorePrivateDataAutomatically': False})
        # The previous successful release now has a rollback-ready cold artifact.
        write_json(self.store / 'successful' / (previous['sha'] + '.json'), previous)
        self.previous = previous
        return previous

    def activate(self, candidate):
        artifact = Path(candidate['artifact'])
        if digest(artifact) != candidate['artifactSha256']:
            raise DeployError('RELEASE_ARTIFACT_CHANGED')
        unpack = self.store / ('unpack-' + uuid.uuid4().hex)
        unpack.mkdir(mode=0o700)
        try:
            self.apply_artifact(candidate, unpack)
        finally:
            shutil.rmtree(unpack, ignore_errors=True)

    def apply_artifact(self, candidate, unpack):
        artifact = Path(candidate['artifact'])
        with tarfile.open(artifact) as tar:
            # Root-owned archive only, previously hashed. Reject any absolute or
            # traversal member before extraction, including package links.
            for member in tar.getmembers():
                path = PurePosixPath(member.name)
                if path.is_absolute() or '..' in path.parts:
                    raise DeployError('RELEASE_ARCHIVE_INVALID')
                if member.issym():
                    link = PurePosixPath(member.linkname)
                    if link.is_absolute():
                        raise DeployError('RELEASE_ARCHIVE_INVALID')
                if member.islnk() or member.isdev() or member.isfifo():
                    raise DeployError('RELEASE_ARCHIVE_INVALID')
            tar.extractall(unpack, filter='data')
        check_links(unpack)
        self.verify_source(candidate['files'], unpack)
        previous_files = self.current['files']
        previous_paths = {entry['path'] for entry in previous_files}
        new_paths = {entry['path'] for entry in candidate['files']}
        for entry in candidate['files']:
            if entry['path'] not in self.controlled_paths and destination(self.project, entry['path']).exists():
                raise DeployError('TRACKED_UNOWNED_COLLISION')
        # Record all controlled candidate paths before the first write, so a
        # partial copy can remove only newly introduced files during rollback.
        self.current = candidate
        self.controlled_paths.update(previous_paths | new_paths)
        for entry in previous_files:
            if entry['path'] not in new_paths:
                destination(self.project, entry['path']).unlink(missing_ok=True)
        account = pwd.getpwnam(APP_USER)
        for entry in candidate['files']:
            target = destination(self.project, entry['path'])
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(unpack / entry['path'], target)
            os.chmod(target, entry['mode'])
            os.chown(target, account.pw_uid, account.pw_gid)
        # Only explicit dependency/build directories are replaced. No broad
        # rsync --delete, private directory sync, or contracts/out replacement.
        for name in ['node_modules', 'frontend/node_modules', 'frontend/.next']:
            incoming = unpack / name
            live = self.project / name
            if live.is_symlink():
                raise DeployError('RELEASE_DESTINATION_SYMLINK')
            if live.exists():
                shutil.rmtree(live)
            if incoming.exists():
                shutil.copytree(incoming, live, symlinks=True)
                for path in [live, *live.rglob('*')]:
                    os.chown(path, account.pw_uid, account.pw_gid, follow_symlinks=False)
        self.verify_source(candidate['files'], self.project)

    def restore_code_and_build(self, backup):
        self.activate(backup)
        self.current = backup

    def finish_rollback(self, backup):
        write_json(self.store / 'current.json', backup or self.previous)

    def health(self, candidate):
        for unit in UNITS:
            active = run(['/usr/bin/systemctl', 'show', unit, '-p', 'ActiveState', '--value']).decode().strip()
            sub = run(['/usr/bin/systemctl', 'show', unit, '-p', 'SubState', '--value']).decode().strip()
            group = run(['/usr/bin/systemctl', 'show', unit, '-p', 'ControlGroup', '--value']).decode().strip()
            cgroup = Path('/sys/fs/cgroup') / group.lstrip('/')
            pids = {int(pid) for path in cgroup.rglob('cgroup.procs') for pid in path.read_text().split()}
            if active != 'active' or sub != 'running' or not pids:
                raise DeployError('SERVICE_HEALTH_FAILED')
            if unit == 'tabby-tempo-runtime.service':
                # The parent being active is insufficient: both privileged
                # settler and Hosted child processes must be alive.
                commands = [Path('/proc/' + str(pid) + '/cmdline').read_bytes() for pid in pids]
                if not all(any(name in value for value in commands) for name in [b'demo-settler.ts', b'hosted-agents.ts']):
                    raise DeployError('RUNTIME_CHILD_MISSING')
        journal = json.loads((self.project / '.data/tempo-20261012/runtime/runtime-journal/session.json').read_text())
        expected_ports = {3028, 3436, 3437, 8794, *journal['ports'].values()}
        observed_ports = set()
        for line in run(['/usr/bin/ss', '-Hlnt']).decode().splitlines():
            columns = line.split()
            if len(columns) < 4:
                raise DeployError('LISTENER_OUTPUT_INVALID')
            address, port = columns[3].rsplit(':', 1)
            if int(port) in expected_ports:
                if address not in {'127.0.0.1', '[::1]'}:
                    raise DeployError('APP_PORT_PUBLIC')
                observed_ports.add(int(port))
        if observed_ports != expected_ports:
            raise DeployError('APP_PORT_MISSING')
        if (self.project / 'frontend/.next/BUILD_ID').read_text().strip() != candidate['buildId']:
            raise DeployError('BUILD_ID_MISMATCH')
        status, body = request('http://127.0.0.1:3437/health')
        health = json.loads(body)
        if status != 200 or health.get('ready') is not True or sorted(health.get('models', [])) != ['kimi-k2.6', 'kimi-k3']:
            raise DeployError('GATEWAY_HEALTH_FAILED')
        status, body = request('http://127.0.0.1:3436/v1/models')
        if status != 200 or sorted(item['id'] for item in json.loads(body)['data']) != ['cheap/kimi-k2.6', 'strong/kimi-k3']:
            raise DeployError('GATEWAY_MODELS_INVALID')
        for url in ['http://127.0.0.1:8794/agents', 'http://127.0.0.1:3028/api/hosted/agents']:
            # Hosted accepts its loopback Host; Next validates the public proxy
            # Host. Match the existing unit wait-ready probes for each boundary.
            headers = {} if ':8794/' in url else {
                'Host': 'tempo.tabbyai.xyz', 'X-Forwarded-Host': 'tempo.tabbyai.xyz', 'X-Forwarded-Proto': 'https'}
            status, body = request(url, headers)
            if status != 401 or json.loads(body).get('error') != 'HOSTED_AUTH_REQUIRED':
                raise DeployError('ANONYMOUS_BOUNDARY_FAILED')
        # No login/challenge, hydration, /api/arena/play, task or model probe.
        for path in ['/', '/dashboard', '/onboarding']:
            status, _ = request('http://127.0.0.1:3028' + path, {'Host': 'tempo.tabbyai.xyz'})
            if status != 200:
                raise DeployError('FRONTEND_HEALTH_FAILED')
        status, _ = request('http://127.0.0.1:3028/api/hosted/agents', {'Host': 'tempo.tabbyai.xyz', 'Origin': 'https://foreign.invalid'})
        if status != 403:
            raise DeployError('ORIGIN_BOUNDARY_FAILED')

    def health_previous(self):
        self.health(self.previous)

    def commit(self, candidate, backup, after):
        successful = {**candidate, 'verifiedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                      'previousSha': backup['sha'], 'log': str(self.log),
                      'trustedGuardVersion': digest(Path(__file__)),
                      'privateDataRestored': False}
        write_json(self.store / 'successful' / (candidate['sha'] + '.json'), successful)
        write_json(self.store / 'current.json', successful)
        write_json(self.store / 'last-state.json', after)
        return {'released': candidate['sha'], 'buildId': candidate['buildId'], 'operation': self.operation, 'privateDataRestored': False}

    def record_failure(self, code, sha):
        write_json(self.store / 'last-failure.json', {'code': code, 'requestedSha': sha,
                   'log': str(self.log), 'maintenance': MAINTENANCE.exists(),
                   'privateDataRestored': False})


def trusted_entry():
    if sys.platform != 'linux' or os.geteuid() != 0 or Path(__file__).resolve() != Path('/usr/local/libexec/tabby-tempo/engine.py'):
        raise DeployError('TRUSTED_ROOT_ENTRY_REQUIRED')
    for path in [Path(__file__).parent, *[Path(__file__).parent / name for name in ['engine.py', 'transaction.py', 'state_guard.py']]]:
        meta = path.stat()
        if meta.st_uid != 0 or stat.S_IMODE(meta.st_mode) & 0o022:
            raise DeployError('TRUSTED_ENTRY_PERMISSIONS_INVALID')


def worker(operation, sha, request_id):
    def terminate(signum, frame):
        raise DeployError('DEPLOY_CANCELLED')
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    receipt = STORE / 'requests' / (request_id + '.json')
    try:
        result = execute(Production(), operation, sha)
        write_json(receipt, {'status': 'Succeeded', **result})
    except BaseException as error:
        write_json(receipt, {'status': 'Failed', 'requestedSha': sha,
                            'code': getattr(error, 'code', 'DEPLOYMENT_FAILED')})
        raise


def cli():
    trusted_entry()
    if len(sys.argv) == 5 and sys.argv[1] == '--worker':
        _, operation, sha, request_id = sys.argv[1:]
        if operation not in {'release', 'rollback'} or not SHA.fullmatch(sha) or not re.fullmatch('[0-9a-f]{32}', request_id):
            raise DeployError('DEPLOY_COMMAND_INVALID')
        worker(operation, sha, request_id)
        return
    if len(sys.argv) != 3:
        raise DeployError('DEPLOY_COMMAND_INVALID')
    operation, sha = sys.argv[1:]
    if operation not in {'release', 'rollback'} or not SHA.fullmatch(sha):
        raise DeployError('DEPLOY_COMMAND_INVALID')
    request_id = uuid.uuid4().hex
    unit = 'tabby-tempo-deploy-' + request_id
    receipt = STORE / 'requests' / (request_id + '.json')
    write_json(receipt, {'status': 'Pending', 'requestedSha': sha, 'unit': unit})
    # PID1 owns the worker. Losing SSH or cancelling Actions does not abandon a
    # half-switched writer; any TERM received by the worker invokes rollback.
    run(['/usr/bin/systemd-run', '--quiet', '--collect', '--unit=' + unit,
         '-p', 'Type=exec', '-p', 'User=root', '-p', 'Group=root',
         '-p', 'WorkingDirectory=/usr/local/libexec/tabby-tempo',
         '-p', 'UMask=0077', '-p', 'RuntimeMaxSec=4500', '-p', 'TimeoutStopSec=1800',
         '-p', 'KillMode=mixed', '/usr/bin/python3', '-I',
         '/usr/local/libexec/tabby-tempo/engine.py', '--worker', operation, sha, request_id])
    print(json.dumps({'accepted': sha, 'requestId': request_id, 'unit': unit}), flush=True)
    deadline = time.monotonic() + 7200
    while time.monotonic() < deadline:
        result = json.loads(receipt.read_text())
        if result['status'] == 'Succeeded':
            print(json.dumps(result))
            return
        if result['status'] == 'Failed':
            raise DeployError(result['code'])
        time.sleep(3)
    raise DeployError('DEPLOY_RECEIPT_TIMEOUT_CHECK_BEFORE_RETRY')


if __name__ == '__main__':
    try:
        cli()
    except Exception as error:
        print(getattr(error, 'code', 'DEPLOYMENT_FAILED'), file=sys.stderr)
        sys.exit(1)
