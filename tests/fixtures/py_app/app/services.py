import logging
from app.models import Account, InsufficientFunds
from . import utils

log = logging.getLogger(__name__)


def transfer(src: Account, dst: Account, amount: float):
    """在两个账户间转账。"""
    try:
        src.withdraw(amount)
    except InsufficientFunds as exc:
        log.warning("failed: %s", exc)
        return False
    else:
        dst.deposit(amount)
    finally:
        utils.audit("transfer", amount)
    for i in range(2):
        if i == 1:
            continue
        helper(i)
    return True


def helper(n):
    acct = Account("tmp", n)
    acct.deposit(n)
    unknown_call(n)
    return [x for x in range(n) if x % 2]
