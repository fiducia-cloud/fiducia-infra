#!/usr/bin/env python3
from dataclasses import dataclass

@dataclass(frozen=True)
class State:
    owner: int
    epoch: int

def next_owner(s: State, owner: int) -> State:
    assert owner in (0, 1)
    return State(owner, s.epoch + 1)

def main() -> None:
    a = State(0, 1)
    b = next_owner(a, 1)
    c = next_owner(b, 0)
    assert a.epoch < b.epoch < c.epoch
    assert a.epoch != c.epoch
    print('ownership epoch model: 3 states, monotonic epochs')

if __name__ == '__main__':
    main()
