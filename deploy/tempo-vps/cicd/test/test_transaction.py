import contextlib
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from transaction import execute, DeployError, error_code, error_details


class Adapter:
    def __init__(self, fail=None, dirty=None):
        self.events = []
        self.fail = fail
        self.dirty = dirty
        self.captures = 0
        self.maintenance = False
        self.current = 'old'
        self.stopped = False
        self.failed_once = False
        self.failures = []

    def event(self, value):
        self.events.append(value)
        if self.fail == value and not self.failed_once:
            self.failed_once = True
            raise DeployError('INJECTED_FAILURE')

    @contextlib.contextmanager
    def lock(self):
        self.event('lock')
        yield

    def validate_request(self, *args): self.event('validate')
    def capture(self):
        self.event('capture')
        self.captures += 1
        return {'n': self.captures, 'dirty': self.captures == self.dirty}
    def require_quiescent(self, value):
        self.event('quiescent')
        if value['dirty']: raise DeployError('STATE_HOSTED_INFLIGHT')
    def compare(self, a, b, phase): self.event('compare:' + phase)
    def prepare(self, *args):
        self.event('prepare')
        return {'sha': 'new'}
    def enter_maintenance(self):
        self.event('maintenance-on')
        self.maintenance = True
    def leave_maintenance(self):
        self.event('maintenance-off')
        self.maintenance = False
    def wait_stable(self): self.event('stable')
    def stop_all(self):
        self.event('stop')
        self.stopped = True
    def backup(self, cold):
        self.event('backup')
        return {'sha': 'old'}
    def activate(self, candidate):
        self.current = 'new'
        self.event('activate')
    def start_all(self):
        self.event('start')
        self.stopped = False
    def reset_failed(self): self.event('reset-failed')
    def health(self, candidate): self.event('health-new')
    def commit(self, *args):
        self.event('commit')
        return {'released': 'new'}
    def restore_code_and_build(self, backup):
        self.event('restore-code-build')
        self.current = 'old'
    def health_previous(self): self.event('health-old')
    def finish_rollback(self, backup): self.event('restore-current-record')
    def record_failure(self, code, sha, **details):
        self.failures.append({'code': code, 'requestedSha': sha, **details})
        self.event('failure:' + code)


class TransactionTest(unittest.TestCase):
    def test_success_drain_before_stop_and_cold_before_activate(self):
        a = Adapter()
        self.assertEqual(execute(a, 'release', 'a' * 40), {'released': 'new'})
        self.assertLess(a.events.index('maintenance-on'), a.events.index('stop'))
        self.assertLess(a.events.index('stable'), a.events.index('stop'))
        self.assertLess(a.events.index('backup'), a.events.index('activate'))
        self.assertFalse(a.maintenance)
        self.assertFalse(a.stopped)
        self.assertNotIn('reset-failed', a.events)

    def test_initial_busy_refused_without_maintenance_or_stop(self):
        a = Adapter(dirty=1)
        with self.assertRaises(DeployError): execute(a, 'release', 'a' * 40)
        self.assertNotIn('prepare', a.events)
        self.assertNotIn('stop', a.events)

    def test_new_request_during_ingress_drain_refused_without_stop(self):
        for dirty in [2, 3]:
            a = Adapter(dirty=dirty)
            with self.assertRaises(DeployError): execute(a, 'release', 'a' * 40)
            self.assertNotIn('stop', a.events)
            self.assertFalse(a.maintenance)

    def test_build_failure_never_enters_maintenance(self):
        a = Adapter(fail='prepare')
        with self.assertRaises(DeployError): execute(a, 'release', 'a' * 40)
        self.assertNotIn('maintenance-on', a.events)
        self.assertNotIn('stop', a.events)

    def test_partial_stop_backup_and_activation_failure_recover(self):
        for failure in ['stop', 'backup', 'activate', 'start', 'health-new', 'commit']:
            with self.subTest(failure=failure):
                a = Adapter(fail=failure)
                with self.assertRaises(DeployError) as error: execute(a, 'release', 'a' * 40)
                self.assertEqual(error.exception.code, 'INJECTED_FAILURE')
                self.assertFalse(a.maintenance)
                self.assertFalse(a.stopped)
                self.assertIn('health-old', a.events)
                self.assertIn('restore-current-record', a.events)
                if failure in ['activate', 'start', 'health-new', 'commit']:
                    self.assertEqual(a.current, 'old')
                self.assertEqual(a.events.count('reset-failed'), 1)
                self.assertLess(a.events.index('reset-failed'), len(a.events) - 1 - a.events[::-1].index('start'))

    def test_after_start_business_dirty_keeps_new_code_stopped_and_journal(self):
        a = Adapter(fail='health-new', dirty=6)
        with self.assertRaises(DeployError) as error: execute(a, 'release', 'a' * 40)
        self.assertEqual(error.exception.code, 'MANUAL_RECONCILIATION_REQUIRED')
        self.assertTrue(a.maintenance)
        self.assertTrue(a.stopped)
        self.assertEqual(a.current, 'new')
        self.assertNotIn('restore-code-build', a.events)
        self.assertNotIn('reset-failed', a.events)
        self.assertEqual(a.failures[-1]['originalCode'], 'INJECTED_FAILURE')
        self.assertEqual(a.failures[-1]['rollbackCode'], 'STATE_HOSTED_INFLIGHT')

    def test_rollback_failure_stops_all_and_preserves_maintenance(self):
        class BrokenRestore(Adapter):
            def restore_code_and_build(self, backup): raise OSError('injected')
        a = BrokenRestore(fail='health-new')
        with self.assertRaises(DeployError) as error: execute(a, 'release', 'a' * 40)
        self.assertEqual(error.exception.code, 'ROLLBACK_FAILED_SERVICES_STOPPED')
        self.assertTrue(a.maintenance)
        self.assertTrue(a.stopped)
        self.assertEqual(a.failures[-1]['originalCode'], 'INJECTED_FAILURE')
        self.assertEqual(a.failures[-1]['rollbackCode'], 'DEPLOYMENT_FAILED')
        self.assertEqual(a.failures[-1]['rollbackPhase'], 'RESTORE_CODE_BUILD')
        self.assertEqual(error_details(error.exception), {key: value for key, value in a.failures[-1].items() if key not in {'code', 'requestedSha'}})

    def test_start_limit_is_reset_once_after_restore_before_rollback_start(self):
        class Limited(Adapter):
            limited = False
            def start_all(self):
                self.event('start')
                if self.current == 'new':
                    self.limited = True
                    raise DeployError('DEPLOY_COMMAND_FAILED')
                if self.limited:
                    raise DeployError('SERVICE_START_LIMIT_HIT')
                self.stopped = False
            def reset_failed(self):
                self.event('reset-failed')
                self.limited = False
        a = Limited()
        with self.assertRaises(DeployError) as error: execute(a, 'release', 'a' * 40)
        self.assertEqual(error.exception.code, 'DEPLOY_COMMAND_FAILED')
        self.assertEqual(a.current, 'old')
        self.assertFalse(a.stopped)
        self.assertFalse(a.maintenance)
        self.assertEqual(a.events.count('start'), 2)
        self.assertEqual(a.events.count('reset-failed'), 1)
        self.assertLess(a.events.index('restore-code-build'), a.events.index('reset-failed'))
        self.assertLess(a.events.index('reset-failed'), len(a.events) - 1 - a.events[::-1].index('start'))
        self.assertEqual(a.failures[-1]['originalPhase'], 'START')
        self.assertEqual(a.failures[-1]['rollbackCode'], 'ROLLBACK_SUCCEEDED')

    def test_rollback_error_retains_original_and_safe_phase_without_secret_text(self):
        secret = 'private-rpc-token-and-signed-payload'
        class BrokenHealth(Adapter):
            def health(self, candidate): raise DeployError('RUNTIME_CHILD_MISSING')
            def health_previous(self):
                error = OSError(secret)
                error.code = secret
                raise error
        a = BrokenHealth()
        with self.assertRaises(DeployError) as error: execute(a, 'release', 'a' * 40)
        self.assertEqual(a.failures[-1]['originalCode'], 'RUNTIME_CHILD_MISSING')
        self.assertEqual(a.failures[-1]['originalPhase'], 'HEALTH')
        self.assertEqual(a.failures[-1]['rollbackCode'], 'DEPLOYMENT_FAILED')
        self.assertEqual(a.failures[-1]['rollbackPhase'], 'HEALTH')
        self.assertNotIn(secret, str(a.failures))
        self.assertNotIn(secret, str(error.exception))
        self.assertTrue(a.stopped)
        self.assertTrue(a.maintenance)

    def test_reset_failure_does_not_retry_or_start_old_services(self):
        class BrokenReset(Adapter):
            def reset_failed(self):
                self.event('reset-failed')
                raise DeployError('DEPLOY_COMMAND_FAILED')
        a = BrokenReset(fail='health-new')
        with self.assertRaises(DeployError): execute(a, 'release', 'a' * 40)
        self.assertEqual(a.events.count('reset-failed'), 1)
        self.assertEqual(a.events.count('start'), 1)
        self.assertEqual(a.failures[-1]['rollbackPhase'], 'RESET_FAILED')
        self.assertTrue(a.stopped)
        self.assertTrue(a.maintenance)

    def test_final_stop_failure_keeps_original_and_rollback_codes_without_claiming_stopped(self):
        class BrokenContainment(Adapter):
            stops = 0
            def health(self, candidate): raise DeployError('RUNTIME_CHILD_MISSING')
            def health_previous(self): raise DeployError('ANONYMOUS_BOUNDARY_FAILED')
            def stop_all(self):
                self.stops += 1
                if self.stops == 3: raise OSError('PRIVATE stop failure')
                super().stop_all()
        a = BrokenContainment()
        with self.assertRaises(DeployError) as error: execute(a, 'release', 'a' * 40)
        self.assertEqual(error.exception.code, 'MANUAL_RECONCILIATION_REQUIRED')
        self.assertEqual(a.failures[-1]['originalCode'], 'RUNTIME_CHILD_MISSING')
        self.assertEqual(a.failures[-1]['rollbackCode'], 'ANONYMOUS_BOUNDARY_FAILED')
        self.assertEqual(a.failures[-1]['rollbackStopCode'], 'DEPLOYMENT_FAILED')
        self.assertEqual(error_details(error.exception)['rollbackCode'], 'ANONYMOUS_BOUNDARY_FAILED')
        self.assertNotIn('PRIVATE', str(a.failures))
        self.assertTrue(a.maintenance)
        self.assertEqual(a.events.count('start'), 2)

    def test_only_trusted_fixed_error_fields_are_serializable(self):
        ordinary = ValueError('PRIVATE')
        ordinary.code = 'PRIVATE'
        self.assertEqual(error_code(ordinary), 'DEPLOYMENT_FAILED')
        invalid = DeployError('https://private.invalid/?token=PRIVATE', originalCode='PRIVATE value', traceback='PRIVATE')
        self.assertEqual(error_code(invalid), 'DEPLOYMENT_FAILED')
        self.assertEqual(error_details(invalid), {})

    def test_worker_termination_uses_same_safe_rollback(self):
        class Cancelled(Adapter):
            def health(self, candidate): raise DeployError('DEPLOY_CANCELLED')
        a = Cancelled()
        with self.assertRaises(DeployError) as error: execute(a, 'release', 'a' * 40)
        self.assertEqual(error.exception.code, 'DEPLOY_CANCELLED')
        self.assertEqual(a.current, 'old')
        self.assertFalse(a.maintenance)


if __name__ == '__main__': unittest.main()
