"""账户模型。"""


class InsufficientFunds(Exception):
    pass


class Account:
    """银行账户。"""

    def __init__(self, owner: str, balance: float = 0):
        self.owner = owner
        self.balance = balance
        self.history = []

    def deposit(self, amount: float) -> float:
        """存入金额并返回新余额。"""
        if amount <= 0:
            raise ValueError("amount must be positive")
        self.balance += amount
        self._record("deposit", amount)
        return self.balance

    def withdraw(self, amount: float) -> float:
        if amount > self.balance:
            raise InsufficientFunds(self.owner)
        self.balance -= amount
        self._record("withdraw", amount)
        return self.balance

    def _record(self, kind, amount):
        self.history.append((kind, amount))
