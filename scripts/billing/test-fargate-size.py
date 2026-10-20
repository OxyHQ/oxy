#!/usr/bin/env python3
"""fargate_size: the Fargate size an operator one-shot takes from a live revision,
including an EC2-only one on the oxy-ec2 capacity (no task-level size)."""
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('inventory', Path(__file__).with_name('commercial-inventory-ecs.py'))
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)
size = inventory.fargate_size

# A Fargate revision keeps its own task size.
assert size({'cpu': '512', 'memory': '1024'}, {'cpu': 0}) == ('512', '1024')
# EC2-only revisions measured live on 2026-10-21: the smallest pair holding the
# container's CPU share and hard memory limit.
assert size({}, {'cpu': 65, 'memory': 1024, 'memoryReservation': 704}) == ('256', '1024')    # clarity-api
assert size({}, {'cpu': 512, 'memory': 1024, 'memoryReservation': 576}) == ('512', '1024')   # mercaria
assert size({}, {'cpu': 1024, 'memory': 3072, 'memoryReservation': 1024}) == ('1024', '3072')  # oxy-api
assert size({'cpu': None, 'memory': None}, {'cpu': 720, 'memory': 8192}) == ('1024', '8192')  # rounds both up
# No memory at all: the 512 MiB floor.
assert size({}, {'cpu': 64}) == ('256', '512')
try:
    size({}, {'cpu': 8192, 'memory': 1024})
    raise AssertionError('an impossible size must be refused')
except SystemExit:
    pass
print('fargate_size: all cases passed')
