"""Pure financial arithmetic shared by the online report endpoint and unit tests.

All amounts are rounded to two decimal places at report boundaries. Stock-only
adjustments are not finance entries. A row can affect only the target field(s)
explicitly named by accounting_target.
"""
import math
from typing import Any, Iterable, Mapping


def _amount(row: Mapping[str, Any], key: str, default: float = 0.0) -> float:
    try:
        value = row.get(key, default)
        return float(default if value is None else value)
    except (TypeError, ValueError):
        return float(default)


def calculate_finance_totals(
    sales: Iterable[Mapping[str, Any]],
    returns: Iterable[Mapping[str, Any]],
    expenses: Iterable[Mapping[str, Any]],
    payments: Iterable[Mapping[str, Any]],
    stock_adjustments: Iterable[Mapping[str, Any]],
    opening_purchase_budget: float = 0.0,
    monthly_expenses_budget: float = 0.0,
) -> dict[str, float]:
    sales = list(sales)
    returns = list(returns)
    expenses = list(expenses)
    payments = list(payments)
    # A reversed inventory adjustment is a tombstone, not an active finance
    # ledger entry. Filter here defensively so stale caches/callers cannot
    # reapply a transfer after its stock transaction has been undone.
    stock_adjustments = [row for row in stock_adjustments if row.get("deleted") is not True]

    gross_revenue = round(sum(_amount(row, "subtotal", _amount(row, "total")) for row in sales), 2)
    sales_revenue = round(sum(_amount(row, "total") for row in sales), 2)
    returns_total = round(sum(_amount(row, "refund_total") for row in returns), 2)
    returns_cogs = round(sum(_amount(row, "refund_cogs") for row in returns), 2)
    revenue = round(sales_revenue - returns_total, 2)

    gross_profit = round(
        sum(_amount(row, "profit") for row in sales)
        - sum(_amount(row, "refund_profit") for row in returns),
        2,
    )
    cogs_goods = round(
        sum(_amount(row, "cogs") for row in sales) - returns_cogs,
        2,
    )
    cogs_expenses = round(sum(_amount(row, "amount") for row in expenses if row.get("bucket") == "cogs"), 2)
    operating_expenses = round(sum(_amount(row, "amount") for row in expenses if row.get("bucket") == "operating"), 2)
    personal_expenses = round(sum(_amount(row, "amount") for row in expenses if row.get("bucket") == "personal"), 2)
    total_expenses = round(cogs_expenses + operating_expenses + personal_expenses, 2)

    supplier_payments = round(sum(_amount(row, "amount") for row in payments if row.get("kind") == "pay"), 2)
    customer_receipts = round(sum(_amount(row, "amount") for row in payments if row.get("kind") == "receive"), 2)
    supplier_refunds = round(sum(_amount(row, "amount") for row in payments if row.get("kind") == "supplier_refund"), 2)
    customer_refunds = round(sum(_amount(row, "amount") for row in payments if row.get("kind") == "customer_refund"), 2)

    # Ignore legacy/corrupted values in the destination not selected by the row.
    net_profit_adjustment = round(sum(
        _amount(row, "net_profit_adjustment")
        for row in stock_adjustments
        if row.get("accounting_target", "none") in ("net_profit", "both", "split_50_50", "net_profit_to_remaining_balance")
    ), 2)
    remaining_balance_adjustment = round(sum(
        _amount(row, "remaining_balance_adjustment")
        for row in stock_adjustments
        if row.get("accounting_target", "none") in ("remaining_balance", "both", "split_50_50", "net_profit_to_remaining_balance")
    ), 2)

    # COGS expenses are routed to Remaining Balance, not Net Profit.
    # Operating and personal expenses both reduce Net Profit.
    net_profit = round(
        gross_profit - operating_expenses - personal_expenses + net_profit_adjustment,
        2,
    )

    # Store formula:
    # Net Sales - Gross Profit - Supplier Payments - Operating Expenses
    # - COGS Expenses + Supplier Refunds + both budget amounts.
    # Keep the two expense buckets in this formula exactly once.
    remaining_balance = round(
        revenue - gross_profit - supplier_payments - operating_expenses - cogs_expenses
        + supplier_refunds
        + float(opening_purchase_budget or 0.0)
        + float(monthly_expenses_budget or 0.0)
        + remaining_balance_adjustment,
        2,
    )

    return {
        "gross_revenue": gross_revenue,
        "sales_revenue": sales_revenue,
        "returns_total": returns_total,
        "returns_cogs": returns_cogs,
        "revenue": revenue,
        "gross_profit": gross_profit,
        "cogs_goods": cogs_goods,
        "cogs_expenses": cogs_expenses,
        "operating_expenses": operating_expenses,
        "personal_expenses": personal_expenses,
        "total_expenses": total_expenses,
        "supplier_payments": supplier_payments,
        "customer_receipts": customer_receipts,
        "supplier_refunds": supplier_refunds,
        "customer_refunds": customer_refunds,
        "net_profit_adjustment": net_profit_adjustment,
        "remaining_balance_adjustment": remaining_balance_adjustment,
        "net_profit": net_profit,
        "remaining_balance": remaining_balance,
    }



def signed_customer_balance_transfer(source_balance: float, requested_amount: float) -> float:
    """Return the signed amount to move out of a customer balance.

    Positive customer balances are receivables; negative balances are credits
    owed by the store. A transfer keeps that sign while moving the value.
    """
    try:
        source = float(source_balance)
        requested = float(requested_amount)
    except (TypeError, ValueError):
        raise ValueError("Transfer amount and source balance must be valid numbers")
    if not math.isfinite(source) or not math.isfinite(requested):
        raise ValueError("Transfer amount and source balance must be valid numbers")
    amount = round(requested, 2)
    available = round(abs(source), 2)
    if amount <= 0:
        raise ValueError("Transfer amount must be greater than zero")
    if available <= 0:
        raise ValueError("The source customer has no remaining balance or credit to transfer")
    if amount > available:
        raise ValueError("Transfer amount cannot exceed the source customer's remaining balance or credit")
    return amount if source > 0 else -amount


def apply_customer_balance_transfers(
    balances: Mapping[str, float],
    transfers: Iterable[Mapping[str, Any]],
) -> dict[str, float]:
    """Apply immutable source-to-destination customer balance ledger entries."""
    result = {
        str(party_id): round(_amount({"balance": balance}, "balance"), 2)
        for party_id, balance in balances.items()
    }
    for transfer in transfers:
        source_id = str(transfer.get("from_party_id") or "")
        destination_id = str(transfer.get("to_party_id") or "")
        if not source_id or not destination_id or source_id == destination_id:
            continue
        signed_amount = round(_amount(transfer, "balance_amount"), 2)
        if signed_amount == 0:
            continue
        result[source_id] = round(result.get(source_id, 0.0) - signed_amount, 2)
        result[destination_id] = round(result.get(destination_id, 0.0) + signed_amount, 2)
    return result
