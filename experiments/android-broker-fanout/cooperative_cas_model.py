"""Non-production model: per-host CAS under a single cooperative authority."""
import threading
import unittest
from dataclasses import dataclass


@dataclass(frozen=True)
class Holder:
    device: str
    secret: str


class Host:
    def __init__(self, value, *, capable=True):
        self.value = value
        self.generation = 0
        self.capable = capable
        self.available = True
        self.lock = threading.Lock()

    def read(self):
        with self.lock:
            if not self.available:
                raise RuntimeError('unavailable')
            return self.value, self.generation

    def legacy_write(self, value):
        # This legacy caller is safe only because the updated host mediates all
        # writes and advances the same generation under the same lock.
        with self.lock:
            self.value = value
            self.generation += 1

    def compare_and_write(self, generation, value):
        with self.lock:
            if not self.capable or not self.available or self.generation != generation:
                return False
            self.value = value
            self.generation += 1
            return True


def reconcile(hosts, candidate, prove, before_write=lambda: None):
    # Capability detection is advisory; the atomic method still has to check
    # its own version/capability. No fallback to unconditional legacy write.
    if any(not host.capable for host in hosts):
        return 'unsupported'
    try:
        snapshots = [host.read() for host in hosts]
    except RuntimeError:
        return 'unavailable'
    if not prove(candidate):
        return 'unproven'
    if any(value is not None and value.device != candidate.device for value, _ in snapshots):
        return 'different-device'
    before_write()
    for host, (value, generation) in zip(hosts, snapshots):
        if value == candidate:
            continue
        if not host.compare_and_write(generation, candidate):
            return 'conflict'
    return 'attempted'


class CooperativeAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.candidate = Holder('device', 'candidate')
        self.old = Holder('device', 'old')
        self.prove = lambda candidate: candidate == self.candidate

    def test_partially_replicated_holder_can_converge(self):
        hosts = [Host(self.candidate), Host(self.old)]
        self.assertEqual(reconcile(hosts, self.candidate, self.prove), 'attempted')
        self.assertEqual([host.read()[0] for host in hosts], [self.candidate, self.candidate])

    def test_other_writer_before_cas_is_not_overwritten(self):
        hosts = [Host(self.candidate), Host(self.old)]
        other = Holder('other-device', 'other-holder')
        self.assertEqual(
            reconcile(hosts, self.candidate, self.prove, lambda: hosts[1].legacy_write(other)),
            'conflict',
        )
        self.assertEqual(hosts[1].read()[0], other)

    def test_unavailable_host_can_be_retried_when_recovered(self):
        hosts = [Host(self.candidate), Host(self.old)]
        hosts[1].available = False
        self.assertEqual(reconcile(hosts, self.candidate, self.prove), 'unavailable')
        hosts[1].available = True
        self.assertEqual(reconcile(hosts, self.candidate, self.prove), 'attempted')
        self.assertEqual(hosts[1].read()[0], self.candidate)

    def test_legacy_host_without_cas_is_left_untouched(self):
        hosts = [Host(self.candidate), Host(self.old, capable=False)]
        self.assertEqual(reconcile(hosts, self.candidate, self.prove), 'unsupported')
        self.assertEqual([host.read()[0] for host in hosts], [self.candidate, self.old])

    def test_failed_proof_and_different_devices_do_not_start_writes(self):
        hosts = [Host(self.old), Host(self.old)]
        self.assertEqual(reconcile(hosts, self.candidate, lambda _: False), 'unproven')
        self.assertEqual([host.read()[0] for host in hosts], [self.old, self.old])
        other = Holder('other-device', 'other-holder')
        hosts[1].legacy_write(other)
        self.assertEqual(reconcile(hosts, self.candidate, self.prove), 'different-device')
        self.assertEqual([host.read()[0] for host in hosts], [self.old, other])

    def test_legacy_write_after_success_can_replace_the_value(self):
        hosts = [Host(self.candidate), Host(self.old)]
        self.assertEqual(reconcile(hosts, self.candidate, self.prove), 'attempted')
        other = Holder('other-device', 'other-holder')
        hosts[1].legacy_write(other)
        self.assertEqual(hosts[1].read()[0], other)

    def test_failure_after_first_host_does_not_roll_back(self):
        hosts = [Host(self.old), Host(self.old)]
        other = Holder('other-device', 'other-holder')
        self.assertEqual(
            reconcile(hosts, self.candidate, self.prove, lambda: hosts[1].legacy_write(other)),
            'conflict',
        )
        self.assertEqual([host.read()[0] for host in hosts], [self.candidate, other])

    def test_already_matching_host_can_change_during_repair(self):
        hosts = [Host(self.candidate), Host(self.old)]
        other = Holder('other-device', 'other-holder')
        self.assertEqual(
            reconcile(hosts, self.candidate, self.prove, lambda: hosts[0].legacy_write(other)),
            'attempted',
        )
        self.assertEqual([host.read()[0] for host in hosts], [other, self.candidate])

    def test_resetting_generation_after_restart_can_overwrite_an_unseen_holder(self):
        original = Host(self.old)
        _, observed = original.read()
        restarted = Host(Holder('other-device', 'other-holder'))
        self.assertTrue(restarted.compare_and_write(observed, self.candidate))
        self.assertEqual(restarted.read()[0], self.candidate)

    def test_a_bypass_writer_that_does_not_advance_generation_breaks_cas(self):
        host = Host(self.old)
        _, observed = host.read()
        host.value = Holder('other-device', 'other-holder')
        self.assertTrue(host.compare_and_write(observed, self.candidate))
        self.assertEqual(host.read()[0], self.candidate)


if __name__ == '__main__':
    unittest.main(verbosity=2)
