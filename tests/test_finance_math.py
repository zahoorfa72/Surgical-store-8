import unittest

from finance_math import calculate_finance_totals


class FinanceMathTests(unittest.TestCase):
    def setUp(self):
        self.sales = [{
            "subtotal": 120.00,
            "total": 100.00,
            "cogs": 60.00,
            "profit": 40.00,
        }]
        self.returns = [{
            "refund_total": 20.00,
            "refund_cogs": 12.00,
            "refund_profit": 8.00,
        }]
        self.expenses = [
            {"bucket": "cogs", "amount": 5.00},
            {"bucket": "operating", "amount": 3.00},
            {"bucket": "personal", "amount": 2.00},
        ]
        self.payments = [
            {"kind": "pay", "amount": 10.00},
            {"kind": "supplier_refund", "amount": 3.00},
            {"kind": "receive", "amount": 25.00},
            {"kind": "customer_refund", "amount": 4.00},
        ]

    def test_discount_returns_and_profit_expense_formula(self):
        result = calculate_finance_totals(
            self.sales, self.returns, self.expenses, self.payments, [],
            opening_purchase_budget=20, monthly_expenses_budget=4,
        )
        self.assertEqual(result["gross_revenue"], 120.00)
        self.assertEqual(result["revenue"], 80.00)
        self.assertEqual(result["cogs_goods"], 48.00)
        self.assertEqual(result["gross_profit"], 32.00)
        self.assertEqual(result["total_expenses"], 10.00)
        self.assertEqual(result["net_profit"], 22.00)
        self.assertEqual(result["remaining_balance"], 60.00)
        self.assertEqual(result["customer_receipts"], 25.00)
        self.assertEqual(result["customer_refunds"], 4.00)

    def test_none_and_inventory_only_are_financially_inert(self):
        adjustments = [
            {"accounting_target": "none", "net_profit_adjustment": 900, "remaining_balance_adjustment": 800},
            {"accounting_target": "inventory_only", "net_profit_adjustment": 700, "remaining_balance_adjustment": 600},
        ]
        result = calculate_finance_totals(self.sales, self.returns, self.expenses, self.payments, adjustments)
        self.assertEqual(result["net_profit_adjustment"], 0)
        self.assertEqual(result["remaining_balance_adjustment"], 0)
        self.assertEqual(result["net_profit"], 22.00)
        self.assertEqual(result["remaining_balance"], 36.00)

    def test_each_selected_destination_is_isolated(self):
        adjustments = [
            {"accounting_target": "net_profit", "net_profit_adjustment": 7, "remaining_balance_adjustment": 999},
            {"accounting_target": "remaining_balance", "net_profit_adjustment": 999, "remaining_balance_adjustment": -4},
            {"accounting_target": "both", "net_profit_adjustment": 2, "remaining_balance_adjustment": 3},
            {"accounting_target": "split_50_50", "net_profit_adjustment": 1.25, "remaining_balance_adjustment": 1.25},
            {"accounting_target": "gross_profit_to_remaining_balance", "net_profit_adjustment": 999, "remaining_balance_adjustment": 999},
        ]
        result = calculate_finance_totals(self.sales, self.returns, self.expenses, self.payments, adjustments)
        self.assertEqual(result["net_profit_adjustment"], 10.25)
        self.assertEqual(result["remaining_balance_adjustment"], 0.25)
        self.assertEqual(result["net_profit"], 32.25)
        self.assertEqual(result["remaining_balance"], 36.25)

    def test_profit_product_and_lost_product_none_do_not_change_gross_profit(self):
        adjustments = [
            {"adjustment_type": "profit_product", "accounting_target": "none", "loss_cost": 1500},
            {"adjustment_type": "lost_product", "accounting_target": "none", "loss_cost": 763},
        ]
        result = calculate_finance_totals(self.sales, self.returns, self.expenses, self.payments, adjustments)
        self.assertEqual(result["gross_profit"], 32.00)
        self.assertEqual(result["net_profit"], 22.00)
        self.assertEqual(result["remaining_balance"], 36.00)


if __name__ == "__main__":
    unittest.main()
