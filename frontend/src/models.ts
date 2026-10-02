// Shared TypeScript types mirroring the backend responses.

export type Product = {
  id: string;
  name: string;
  barcode: string;
  quantity: number;
  purchase_price: number;
  sale_price: number;
  low_stock_threshold: number;
  created_at: string;
  updated_at: string;
  expiry_date?: string | null;
};

export type PartyType = "supplier" | "customer";
export type Party = {
  id: string;
  name: string;
  type: PartyType;
  phone: string;
  address: string;
  created_at: string;
  balance: number; // supplier: we owe; customer: they owe us
};

export type PaymentKind = "pay" | "receive" | "supplier_refund" | "customer_refund";
export type Payment = {
  id: string;
  party_id: string;
  party_name: string;
  party_type: PartyType;
  kind: PaymentKind;
  amount: number;
  adjustment: number;
  note: string;
  user_name: string;
  created_at: string;
};

export type Budget = { monthly_amount: number; opening_amount?: number; spent_this_month: number; purchase_spent?: number; purchase_remaining?: number };

export type InventoryUsageRow = {
  product_id: string;
  name: string;
  quantity: number;
  rank: number;
  level: "High" | "Medium" | "Low";
};

export type SaleItem = {
  product_id: string;
  name: string;
  quantity: number;
  unit_price: number;
  purchase_price: number;
  line_total: number;
};

export type Sale = {
  id: string;
  invoice_no: string;
  items: SaleItem[];
  customer_id?: string | null;
  customer_name: string;
  subtotal: number;
  discount: number;
  total: number;
  cogs: number;
  profit: number;
  note: string;
  cashier_id?: string;
  cashier_name: string;
  credit?: boolean; // sold on credit -> adds to customer's owed balance
  created_at: string;
  pending?: boolean; // true while a locally-created sale is waiting to sync
};

export type PurchaseItem = {
  product_id: string;
  name: string;
  quantity: number;
  unit_cost: number;
  line_total: number;
};

export type Purchase = {
  id: string;
  ref_no: string;
  items: PurchaseItem[];
  supplier_id?: string | null;
  supplier_name: string;
  total: number;
  note: string;
  user_name: string;
  created_at: string;
  pending?: boolean; // true while a locally-created purchase is waiting to sync
};

export type ExpenseBucket = "cogs" | "operating" | "personal";
export type Expense = {
  id: string;
  title: string;
  category: string;
  bucket: ExpenseBucket;
  amount: number;
  note: string;
  user_name: string;
  created_at: string;
};

export type ReportSummary = {
  range: string;
  revenue: number;
  gross_revenue: number;
  returns_total: number;
  returns_count: number;
  cogs_goods: number;
  cogs_expenses: number;
  cogs_total: number;
  personal_expenses: number;
  gross_profit: number;
  operating_expenses: number;
  total_expenses: number;
  supplier_payments: number;
  customer_receipts: number;
  net_profit: number;
  remaining_balance: number;
  units_sold: number;
  transactions: number;
  purchase_total: number;
  purchase_gross?: number;
  purchase_returns_total?: number;
  inventory_value: number;
  product_count: number;
  low_stock: Product[];
};

export type ReturnItem = {
  product_id: string;
  name: string;
  quantity: number;
  unit_price: number;
  purchase_price: number;
  line_total: number;
};

export type ReturnRecord = {
  id: string;
  ref_no: string;
  sale_id: string;
  invoice_no: string;
  customer_name: string;
  items: ReturnItem[];
  refund_total: number;
  refund_cogs: number;
  refund_profit: number;
  reason: string;
  user_name: string;
  created_at: string;
};

export type DayCloseRow = {
  user_name: string;
  transactions: number;
  units: number;
  gross_sales: number;
  discount: number;
  range?: string;
};

export type DayClose = {
  me: DayCloseRow;
  by_user: DayCloseRow[] | null;
};

export type CustomerRow = {
  customer_id?: string | null;
  name: string;
  orders: number;
  total: number;
  units: number;
};

export const EXPENSE_CATEGORIES = [
  "Rent",
  "Salaries",
  "Utilities",
  "Supplies",
  "Transport",
  "Marketing",
  "Maintenance",
  "Other",
];
