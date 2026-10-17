import pytest
from app.models import Account
from app.services import transfer


def test_transfer_ok():
    a = Account("a", 10)
    b = Account("b")
    assert transfer(a, b, 5)


def test_transfer_insufficient():
    assert not transfer(Account("a"), Account("b"), 5)


class TestAccount:
    def test_deposit(self):
        acct = Account("x")
        assert acct.deposit(3) == 3
