#!/usr/bin/python3 -I
"""One-time operator installation, never called by an application release."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import engine
from state_guard import capture, require_quiescent
from transaction import DeployError

TRUSTED = Path('/usr/local/libexec/tabby-tempo')
DEPLOY_USER = 'tabby-tempo-deploy'
DEPLOY_HOME = Path('/var/lib/tabby-tempo-deploy')
NGINX_SITE = Path('/etc/nginx/sites-available/tempo.tabbyai.xyz')
NGINX_INCLUDE = Path('/etc/nginx/snippets/tabby-tempo-cicd-maintenance.conf')
SUDOERS = Path('/etc/sudoers.d/tabby-tempo-cicd')
TMPFILES = Path('/etc/tmpfiles.d/tabby-tempo-cicd.conf')
SSH_CONFIG = Path('/etc/ssh/sshd_config')
ENTRY_FILES = ['engine.py', 'state_guard.py', 'transaction.py', 'ssh-entry']


def maintenance_config(text):
    marker = '    listen 443 ssl http2;\n    server_name tempo.tabbyai.xyz;\n'
    if text.count(marker) != 1 or 'tabby-tempo-cicd' in text:
        raise DeployError('NGINX_SITE_REQUIRES_OPERATOR')
    return text.replace(marker, marker + '    include /etc/nginx/snippets/tabby-tempo-cicd-maintenance.conf;\n', 1)


def authorized_key(value):
    value = value.strip()
    if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/]+={0,3}(?: [A-Za-z0-9@._+-]+)?', value):
        raise DeployError('DEPLOY_PUBLIC_KEY_INVALID')
    return 'restrict,command="/usr/local/libexec/tabby-tempo/ssh-entry" ' + value + '\n'


def ssh_config(text):
    if 'tabby-tempo-cicd' in text:
        raise DeployError('SSH_CONFIG_REQUIRES_OPERATOR')
    # Append at the end, outside the distro's early Include: Match scopes must
    # not turn the remaining global directives into invalid Match directives.
    return text.rstrip() + '\n\n# tabby-tempo-cicd: dedicated key-only account\n' + '''Match User tabby-tempo-deploy
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AuthenticationMethods publickey
    DisableForwarding yes
    PermitTTY no
    PermitUserRC no
    ForceCommand /usr/local/libexec/tabby-tempo/ssh-entry
'''


def ssh_effective(user):
    return engine.run(['/usr/sbin/sshd', '-T', '-C', 'user=' + user + ',host=tempo.tabbyai.xyz,addr=127.0.0.1'])


def configure_ssh():
    original = SSH_CONFIG.read_bytes()
    configured = ssh_config(original.decode())
    others = {user: ssh_effective(user) for user in ['root', 'tabby-tempo', 'nobody']}
    backup = engine.STORE / 'installation-backup/sshd-config.before'
    if backup.exists(): raise DeployError('SSH_CONFIG_REQUIRES_OPERATOR')
    root_file(backup, original, 0o600)
    try:
        root_file(SSH_CONFIG, configured)
        engine.run(['/usr/sbin/sshd', '-t'])
        if any(ssh_effective(user) != value for user, value in others.items()):
            raise DeployError('OTHER_SSH_ACCOUNT_CONFIGURATION_CHANGED')
        effective = dict(line.split(' ', 1) for line in ssh_effective(DEPLOY_USER).decode().splitlines())
        required = {'pubkeyauthentication': 'yes', 'passwordauthentication': 'no',
                    'kbdinteractiveauthentication': 'no', 'authenticationmethods': 'publickey',
                    'disableforwarding': 'yes', 'permittty': 'no', 'permituserrc': 'no',
                    'forcecommand': '/usr/local/libexec/tabby-tempo/ssh-entry'}
        if any(effective.get(key) != value for key, value in required.items()):
            raise DeployError('DEPLOY_SSH_CONFIGURATION_INVALID')
        engine.run(['/usr/bin/systemctl', 'reload', 'ssh'])
        return {'sshdBeforeSha256': hashlib.sha256(original).hexdigest(),
                'sshdAfterSha256': engine.digest(SSH_CONFIG), 'otherAccountsEffectiveUnchanged': True,
                'deployAuthentication': required}
    except Exception:
        root_file(SSH_CONFIG, original)
        engine.run(['/usr/sbin/sshd', '-t'])
        engine.run(['/usr/bin/systemctl', 'reload', 'ssh'])
        backup.unlink(missing_ok=True)
        raise


def root_file(path, value, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink(): raise DeployError('INSTALL_DESTINATION_SYMLINK')
    path.write_bytes(value if isinstance(value, bytes) else value.encode())
    os.chmod(path, mode)
    os.chown(path, 0, 0)


def install(baseline, public_key):
    if sys.platform != 'linux' or os.geteuid() != 0 or sys.version_info < (3, 12):
        raise DeployError('LINUX_ROOT_PYTHON_312_REQUIRED')
    if not engine.SHA.fullmatch(baseline): raise DeployError('BASELINE_SHA_INVALID')
    if engine.PROJECT.is_symlink() or engine.PROJECT.resolve() != engine.PROJECT or Path('/srv/tabby-tempo').resolve() != engine.PROJECT:
        raise DeployError('PROJECT_PATH_INVALID')
    key_line = authorized_key(public_key.read_text())
    engine.run(['/usr/bin/ssh-keygen', '-l', '-f', str(public_key)])
    # Never install over a previous trusted entry or overwrite an operator's
    # manual maintenance state. Upgrades use the separate documented review.
    for path in [TRUSTED, SUDOERS, NGINX_INCLUDE, TMPFILES, engine.STORE, engine.MAINTENANCE]:
        if path.exists(): raise DeployError('CICD_ALREADY_INSTALLED_OR_MANUAL_STATE')
    for user in [DEPLOY_USER, engine.BUILD_USER]:
        try: pwd.getpwnam(user)
        except KeyError: pass
        else: raise DeployError('CICD_ACCOUNT_ALREADY_EXISTS')
    original_nginx = NGINX_SITE.read_bytes()
    original_ssh = SSH_CONFIG.read_bytes()
    configured_nginx = maintenance_config(original_nginx.decode())
    before = capture(engine.PROJECT)
    require_quiescent(before)
    engine.run(['/usr/sbin/nginx', '-t'])
    if shutil.disk_usage('/var/lib').free < 4 * 1024 ** 3:
        raise DeployError('DEPLOY_DISK_BUDGET_INSUFFICIENT')
    # Fetch a public repository to a root-only temporary enrollment directory.
    # The running application has no .git and is never checked out in place.
    temporary = Path('/var/lib') / ('tabby-tempo-enroll-' + uuid.uuid4().hex)
    temporary.mkdir(mode=0o700)
    created_users = []
    installed = []
    success = False
    ssh_changed = False
    try:
        repo = temporary / 'repo.git'
        engine.run(['/usr/bin/git', 'init', '--bare', str(repo)])
        engine.run(['/usr/bin/git', '--git-dir=' + str(repo), 'fetch', '--no-tags', engine.REPO,
                    '+refs/heads/main:refs/heads/main'], timeout=180)
        adapter = engine.Production.__new__(engine.Production)
        adapter.project, adapter.store, adapter.repo = engine.PROJECT, temporary, repo
        adapter.log = temporary / 'enrollment.log'
        adapter.git('merge-base', '--is-ancestor', baseline, 'refs/heads/main')
        files = adapter.source(baseline)
        adapter.verify_source(files, engine.PROJECT, generated=True)
        files = [{**entry, 'sha256': engine.digest(engine.destination(engine.PROJECT, entry['path']))} for entry in files]
        build_id = (engine.PROJECT / 'frontend/.next/BUILD_ID').read_text().strip()
        adapter.current = {'sha': baseline, 'files': files, 'buildId': build_id}
        adapter.previous = adapter.current
        adapter.health(adapter.current)
        second = capture(engine.PROJECT)
        require_quiescent(second)
        engine.compare(before, second, 'build')
        engine.STORE.mkdir(mode=0o700)
        installed.append(engine.STORE)
        shutil.move(str(repo), engine.STORE / 'repo.git')
        record = {**adapter.current, 'verifiedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                  'enrolled': True, 'privateDataRestored': False}
        engine.write_json(engine.STORE / 'current.json', record)
        engine.write_json(engine.STORE / 'successful' / (baseline + '.json'), record)
        engine.write_json(engine.STORE / 'enrollment-state.json', second)
        backup = engine.STORE / 'installation-backup'
        backup.mkdir(mode=0o700)
        root_file(backup / 'nginx-site.before', original_nginx, 0o600)
        for user, home in [(DEPLOY_USER, DEPLOY_HOME), (engine.BUILD_USER, engine.BUILD_ROOT)]:
            engine.run(['/usr/sbin/useradd', '--system', '--user-group', '--home-dir', str(home),
                        '--shell', '/bin/sh' if user == DEPLOY_USER else '/usr/sbin/nologin', user])
            created_users.append(user)
        # Password login is locked; the deploy account's shell only starts the
        # root-owned forced command. Build user has no app/docker membership.
        engine.run(['/usr/sbin/usermod', '-L', DEPLOY_USER])
        DEPLOY_HOME.mkdir(mode=0o755)
        installed.append(DEPLOY_HOME)
        (DEPLOY_HOME / '.ssh').mkdir(mode=0o755)
        root_file(DEPLOY_HOME / '.ssh/authorized_keys', key_line, 0o644)
        engine.BUILD_ROOT.mkdir(mode=0o700)
        installed.append(engine.BUILD_ROOT)
        build_account = pwd.getpwnam(engine.BUILD_USER)
        os.chown(engine.BUILD_ROOT, build_account.pw_uid, build_account.pw_gid)
        TRUSTED.mkdir(parents=True, mode=0o755)
        installed.append(TRUSTED)
        for name in ENTRY_FILES:
            root_file(TRUSTED / name, (HERE / name).read_bytes(), 0o755 if name == 'ssh-entry' else 0o644)
        root_file(SUDOERS, DEPLOY_USER + ' ALL=(root) NOPASSWD: /usr/bin/python3 -I /usr/local/libexec/tabby-tempo/engine.py release *, /usr/bin/python3 -I /usr/local/libexec/tabby-tempo/engine.py rollback *\n', 0o440)
        installed.append(SUDOERS)
        engine.run(['/usr/sbin/visudo', '-cf', str(SUDOERS)])
        root_file(TMPFILES, 'd /run/tabby-tempo-cicd 0755 root root -\n')
        installed.append(TMPFILES)
        engine.run(['/usr/bin/systemd-tmpfiles', '--create', str(TMPFILES)])
        root_file(NGINX_INCLUDE, 'if (-f /run/tabby-tempo-cicd/maintenance) { return 503; }\n')
        installed.append(NGINX_INCLUDE)
        root_file(NGINX_SITE, configured_nginx)
        engine.run(['/usr/sbin/nginx', '-t'])
        engine.run(['/usr/bin/systemctl', 'reload', 'nginx'])
        ssh_proof = configure_ssh()
        ssh_changed = True
        for user in [DEPLOY_USER, engine.BUILD_USER]:
            groups = engine.run(['/usr/bin/id', '-nG', user]).decode().split()
            if groups != [user]: raise DeployError('CICD_ACCOUNT_GROUP_INVALID')
        final = capture(engine.PROJECT)
        require_quiescent(final)
        engine.compare(second, final, 'build')
        adapter.health(adapter.current)
        proof = {'baselineSha': baseline, 'buildId': build_id,
                 'trustedFiles': {name: engine.digest(TRUSTED / name) for name in ENTRY_FILES},
                 'nginxBeforeSha256': hashlib.sha256(original_nginx).hexdigest(),
                 'nginxAfterSha256': engine.digest(NGINX_SITE), 'appServicesStopped': False,
                 'applicationDeployed': False, 'privateDataRestored': False, **ssh_proof}
        engine.write_json(engine.STORE / 'installation.json', proof)
        success = True
        return proof
    finally:
        if not success:
            # Restore only this site's original config and the newly installed
            # infrastructure. Running application code/data are never touched.
            root_file(NGINX_SITE, original_nginx)
            try:
                engine.run(['/usr/sbin/nginx', '-t'])
                engine.run(['/usr/bin/systemctl', 'reload', 'nginx'])
            except Exception: pass
            if ssh_changed:
                root_file(SSH_CONFIG, original_ssh)
                try:
                    engine.run(['/usr/sbin/sshd', '-t'])
                    engine.run(['/usr/bin/systemctl', 'reload', 'ssh'])
                except Exception: pass
            for path in reversed(installed):
                if path.is_dir(): shutil.rmtree(path, ignore_errors=True)
                else: path.unlink(missing_ok=True)
            for user in reversed(created_users):
                try: engine.run(['/usr/sbin/userdel', user])
                except Exception: pass
        shutil.rmtree(temporary, ignore_errors=True)


def cli():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true', required=True)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--public-key-file', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(install(args.baseline, args.public_key_file)))


if __name__ == '__main__':
    try: cli()
    except Exception as error:
        print(getattr(error, 'code', 'CICD_INSTALL_FAILED'), file=sys.stderr)
        sys.exit(1)
