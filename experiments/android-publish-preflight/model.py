"""Synthetic model of resolution failure; not an Android/provider test."""
from dataclasses import dataclass

@dataclass
class Host:
    installed: bool = True
    lookup_error: bool = False
    slot: str = 'previous'
    writes: int = 0


def publish_current(hosts):
    confirmed = 0
    stale = False
    for host in hosts:
        # Current isInstalled catches lookup errors and returns false.
        if host.lookup_error or not host.installed:
            continue
        host.slot = 'candidate'
        host.writes += 1
        confirmed += 1
    return confirmed > 0 and not stale


def publish_preflight(hosts):
    present = []
    for host in hosts:
        if host.lookup_error:
            return False
        if host.installed:
            present.append(host)
    for host in present:
        host.slot = 'candidate'
        host.writes += 1
    return bool(present)


def main():
    for failing_position in (0, 1):
        hosts = [Host(), Host()]
        hosts[failing_position].lookup_error = True
        assert publish_current(hosts) is True
        assert [h.slot for h in hosts].count('candidate') == 1
        hosts = [Host(), Host()]
        hosts[failing_position].lookup_error = True
        assert publish_preflight(hosts) is False
        assert all(h.writes == 0 and h.slot == 'previous' for h in hosts)
        hosts[failing_position].lookup_error = False
        assert publish_preflight(hosts) is True
        assert all(h.slot == 'candidate' for h in hosts)
    assert publish_preflight([Host(installed=False), Host(installed=False)]) is False
    assert publish_preflight([Host(installed=True), Host(installed=False)]) is True
    # This preflight does not change the existing failed-write cleanup. A
    # replacement can still arrive after the preflight and before clear.
    hosts = [Host(), Host()]
    assert all(host.installed and not host.lookup_error for host in hosts)
    hosts[0].slot = 'candidate'  # first write succeeds
    hosts[1].slot = 'replacement'  # another process writes after a failed write
    hosts[1].slot = ''  # current unconditional clear erases it
    assert hosts[1].slot == ''
    print('synthetic model: masked lookup failure reproduced; preflight rejects without writes and recovers on retry')
    print('synthetic model: preflight does not prevent failed-write cleanup erasing a concurrent replacement')

if __name__ == '__main__':
    main()
