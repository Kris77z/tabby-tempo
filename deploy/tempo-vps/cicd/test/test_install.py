import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import engine
import install
from transaction import DeployError


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.project = self.root / 'project'
        self.project.mkdir()
        (self.project / 'frontend/.next').mkdir(parents=True)
        (self.project / 'frontend/.next/BUILD_ID').write_text('OLD_BUILD')
        (self.project / 'source.txt').write_text('OLD_SOURCE')
        (self.project / '.data').mkdir()
        (self.project / '.data/private').write_text('PRIVATE_STATE')
        self.srv = self.root / 'srv'
        self.srv.symlink_to(self.project, target_is_directory=True)
        self.site = self.root / 'nginx-site'
        self.original = 'server {\n    listen 443 ssl http2;\n    server_name tempo.tabbyai.xyz;\n}\n'
        self.site.write_text(self.original)
        self.ssh_config = self.root / 'sshd-config'
        self.ssh_original = 'PubkeyAuthentication no\nPasswordAuthentication yes\n'
        self.ssh_config.write_text(self.ssh_original)
        self.pub = self.root / 'public.key'
        self.pub.write_text('ssh-ed25519 AAAATEST synthetic-test')
        self.accounts = set()
        self.commands = []

    def fake_run(self, args, **kwargs):
        self.commands.append(args)
        if args[:3] == ['/usr/bin/git', 'init', '--bare']: Path(args[3]).mkdir()
        if args[0] == '/usr/sbin/useradd': self.accounts.add(args[-1])
        if args[0] == '/usr/sbin/userdel': self.accounts.discard(args[-1])
        if args[:2] == ['/usr/bin/id', '-nG']: return (args[-1] + '\n').encode()
        if args[:2] == ['/usr/sbin/sshd', '-T']:
            if 'user=tabby-tempo-deploy' in args[-1] and 'Match User' in self.ssh_config.read_text():
                return b'pubkeyauthentication yes\npasswordauthentication no\nkbdinteractiveauthentication no\nauthenticationmethods publickey\ndisableforwarding yes\npermittty no\npermituserrc no\nforcecommand /usr/local/libexec/tabby-tempo/ssh-entry\n'
            return b'pubkeyauthentication no\npasswordauthentication yes\n'
        return b''

    def account(self, name):
        if name not in self.accounts: raise KeyError(name)
        return types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())

    def patches(self):
        values = {
            'TRUSTED': self.root / 'trusted', 'DEPLOY_HOME': self.root / 'home',
            'NGINX_SITE': self.site, 'NGINX_INCLUDE': self.root / 'include',
            'SUDOERS': self.root / 'sudoers', 'TMPFILES': self.root / 'tmpfiles', 'SSH_CONFIG': self.ssh_config}
        contexts = [patch.object(install, name, value) for name, value in values.items()]
        contexts += [patch.object(engine, 'PROJECT', self.project), patch.object(engine, 'STORE', self.root / 'store'),
                     patch.object(engine, 'BUILD_ROOT', self.root / 'build'), patch.object(engine, 'MAINTENANCE', self.root / 'run/maintenance'),
                     patch.object(install.sys, 'platform', 'linux'), patch.object(install.os, 'geteuid', return_value=0),
                     patch.object(install.os, 'chown'), patch.object(engine, 'run', side_effect=self.fake_run),
                     patch.object(install.pwd, 'getpwnam', side_effect=self.account),
                     patch.object(install, 'capture', return_value={'stable': True}), patch.object(install, 'require_quiescent'),
                     patch.object(engine, 'compare'), patch.object(engine.Production, 'health'),
                     patch.object(engine.Production, 'source', return_value=[{'path': 'source.txt', 'sha256': engine.digest(self.project / 'source.txt'), 'mode': 0o644}]),
                     patch.object(install, 'Path', side_effect=lambda value: self.srv if value == '/srv/tabby-tempo' else Path(value)),
                     patch.object(engine.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=10 * 1024 ** 3))]
        for context in contexts:
            context.start()
            self.addCleanup(context.stop)

    def preserved(self):
        self.assertEqual((self.project / 'source.txt').read_text(), 'OLD_SOURCE')
        self.assertEqual((self.project / '.data/private').read_text(), 'PRIVATE_STATE')
        self.assertFalse(any(command[:2] == ['/usr/bin/systemctl', 'stop'] for command in self.commands))
        self.assertFalse(list(Path('/var/lib').glob('tabby-tempo-enroll-*')))

    def test_install_enrolls_without_deploying_or_stopping(self):
        self.patches()
        # Only the temporary enrollment directory needs a writable local parent.
        real_path = Path
        with patch.object(install, 'Path', side_effect=lambda value: self.srv if value == '/srv/tabby-tempo' else self.root if value == '/var/lib' else real_path(value)):
            proof = install.install('a' * 40, self.pub)
        self.assertFalse(proof['applicationDeployed'])
        self.assertFalse(proof['appServicesStopped'])
        self.assertEqual(proof['buildId'], 'OLD_BUILD')
        self.assertIn('include /etc/nginx/snippets', self.site.read_text())
        self.assertEqual(json.loads((self.root / 'store/current.json').read_text())['sha'], 'a' * 40)
        self.assertEqual(self.accounts, {'tabby-tempo-build', 'tabby-tempo-deploy'})
        self.preserved()

    def test_failure_restores_only_site_and_removes_new_infrastructure(self):
        self.patches()
        original_run = self.fake_run
        def failed(args, **kwargs):
            if args[:2] == ['/usr/bin/id', '-nG']: return b'docker\n'
            return original_run(args, **kwargs)
        with patch.object(engine, 'run', side_effect=failed), patch.object(install, 'Path', side_effect=lambda value: self.srv if value == '/srv/tabby-tempo' else self.root if value == '/var/lib' else Path(value)):
            with self.assertRaises(DeployError) as error: install.install('a' * 40, self.pub)
        self.assertEqual(error.exception.code, 'CICD_ACCOUNT_GROUP_INVALID')
        self.assertEqual(self.site.read_text(), self.original)
        self.assertEqual(self.ssh_config.read_text(), self.ssh_original)
        self.assertFalse(self.accounts)
        for name in ['store', 'home', 'build', 'trusted', 'sudoers', 'include', 'tmpfiles']:
            self.assertFalse((self.root / name).exists(), name)
        self.preserved()

    def test_nginx_requires_unique_fixed_site_marker(self):
        for text in [self.original * 2, self.original.replace('443 ssl http2', '8443 ssl'), self.original + '# tabby-tempo-cicd']:
            with self.assertRaises(DeployError): install.maintenance_config(text)

    def test_authorized_key_is_restricted_and_rejects_option_injection(self):
        self.assertTrue(install.authorized_key(self.pub.read_text()).startswith('restrict,command="/usr/local/libexec/tabby-tempo/ssh-entry" ssh-ed25519'))
        for key in ['command="id" ssh-ed25519 AAAA', 'ssh-rsa AAAA', 'ssh-ed25519 AAAA\nssh-ed25519 BBBB']:
            with self.assertRaises(DeployError): install.authorized_key(key)

    def test_ssh_match_appended_after_global_config_and_does_not_enable_root(self):
        configured = install.ssh_config('Include /etc/ssh/sshd_config.d/*.conf\nUsePAM yes\nPubkeyAuthentication no\n')
        self.assertEqual(configured.count('Match User'), 1)
        self.assertTrue(configured.index('UsePAM yes') < configured.index('Match User tabby-tempo-deploy'))
        self.assertNotIn('Match User root', configured)
        with self.assertRaises(DeployError): install.ssh_config(configured)

    def test_ssh_validation_failure_restores_configuration(self):
        self.patches()
        original_run = self.fake_run
        def failed(args, **kwargs):
            if args[:2] == ['/usr/sbin/sshd', '-T'] and 'user=root' in args[-1] and 'Match User' in self.ssh_config.read_text():
                return b'CHANGED_ROOT_CONFIGURATION\n'
            return original_run(args, **kwargs)
        with patch.object(engine, 'run', side_effect=failed):
            with self.assertRaises(DeployError) as error: install.configure_ssh()
        self.assertEqual(error.exception.code, 'OTHER_SSH_ACCOUNT_CONFIGURATION_CHANGED')
        self.assertEqual(self.ssh_config.read_text(), self.ssh_original)
        self.assertFalse((self.root / 'store/installation-backup/sshd-config.before').exists())


if __name__ == '__main__': unittest.main()
