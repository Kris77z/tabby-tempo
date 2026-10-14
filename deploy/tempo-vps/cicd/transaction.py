"""Deployment order and rollback policy; the adapter owns the fixed VPS I/O."""
from __future__ import annotations


class DeployError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def execute(adapter, operation: str, sha: str):
    """Never restores private data. An uncertain running state requires an operator."""
    with adapter.lock():
        adapter.validate_request(operation, sha)
        before = adapter.capture()
        adapter.require_quiescent(before)
        candidate = adapter.prepare(operation, sha)
        try:
            adapter.enter_maintenance()
            fresh = adapter.capture()
            adapter.require_quiescent(fresh)
            adapter.compare(before, fresh, 'build')
            adapter.wait_stable()
            stable = adapter.capture()
            adapter.require_quiescent(stable)
            adapter.compare(fresh, stable, 'build')
            fresh = stable
        except Exception:
            adapter.leave_maintenance()
            raise
        stopped = False
        activated = False
        start_attempted = False
        backup = None
        cold = None
        try:
            # Set the flag before stop: a partially failed systemctl stop still
            # requires stopping all Upholds-linked units before any recovery.
            stopped = True
            adapter.stop_all()
            cold = adapter.capture()
            adapter.require_quiescent(cold)
            adapter.compare(fresh, cold, 'cold')
            backup = adapter.backup(cold)
            activated = True
            adapter.activate(candidate)
            adapter.compare(cold, adapter.capture(), 'build')
            start_attempted = True
            adapter.start_all()
            adapter.health(candidate)
            after = adapter.capture()
            adapter.require_quiescent(after)
            adapter.compare(cold, after, 'restart')
            result = adapter.commit(candidate, backup, after)
            adapter.leave_maintenance()
            return result
        except Exception as error:
            if not stopped:
                raise
            try:
                adapter.stop_all()
                current = adapter.capture()
                adapter.require_quiescent(current)
                if cold is not None:
                    adapter.compare(cold, current, 'restart' if start_attempted else 'build')
                else:
                    adapter.compare(fresh, current, 'cold')
            except Exception:
                adapter.record_failure('MANUAL_RECONCILIATION_REQUIRED', sha)
                raise DeployError('MANUAL_RECONCILIATION_REQUIRED') from None
            try:
                if activated:
                    if backup is None:
                        raise DeployError('BACKUP_NOT_READY')
                    adapter.restore_code_and_build(backup)
                adapter.start_all()
                adapter.health_previous()
                recovered = adapter.capture()
                adapter.require_quiescent(recovered)
                adapter.compare(current, recovered, 'restart')
                adapter.finish_rollback(backup)
                adapter.leave_maintenance()
            except Exception:
                adapter.stop_all()
                adapter.record_failure('ROLLBACK_FAILED_SERVICES_STOPPED', sha)
                raise DeployError('ROLLBACK_FAILED_SERVICES_STOPPED') from None
            code = getattr(error, 'code', 'DEPLOYMENT_FAILED_ROLLED_BACK')
            adapter.record_failure(code, sha)
            raise DeployError(code) from None
