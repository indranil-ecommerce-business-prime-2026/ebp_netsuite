# Dropship Bill Test — Verification Report

**Date:** March 29, 2026

> None of the Dropship POs currently in MongoDB have associated vendor bills yet, so there was no real Dropship data available to test the bill pipeline. We created the demo records below to validate the full Dropship flow (SO → PO → Bill). Please verify these three records in NetSuite using the values listed.

---

## 1. Sales Order

**Find in NetSuite:** Transactions > Sales Orders > List > Other Ref # = `TEST-DS-BILL-001`

| Field | Value |
|-------|-------|
| Other Ref # | TEST-DS-BILL-001 |
| Date | 3/29/2026 |
| Customer | Amazon |
| Order Status | Unshipped |
| Fulfillment | MFN |
| Ship To | Test Dropship Customer, 123 Test Street, Los Angeles, CA 90001, US |
| Item | 29S0100 |
| Qty | 2 |
| Amount | $137.62 |

---

## 2. Purchase Order (Dropship)

**Find in NetSuite:** Transactions > Purchase Orders > List > Other Ref # = `999001`

| Field | Value |
|-------|-------|
| PO # | PO999001 |
| Other Ref # | 999001 |
| Date | 3/29/2026 |
| Vendor | TD Synnex - Term (ID 116) |
| Distributor Order # | DS-TEST-001 |
| Location | Dropship |
| Linked SO | TEST-DS-BILL-001 |
| Ship To | Copied from SO above |
| Item | 29S0100 |
| Qty | 2 |
| Rate | $68.81 |
| Amount | $137.62 |

---

## 3. Vendor Bill

**Find in NetSuite:** Transactions > Payables > Enter Bills > List > Other Ref # = `PO999001-INV-DS-TEST-001`

| Field | Value |
|-------|-------|
| Bill # | PO999001-INV-DS-TEST-001 |
| Other Ref # | PO999001-INV-DS-TEST-001 |
| Date | 3/29/2026 |
| Due Date | 4/29/2026 |
| Vendor | TD Synnex - Term (ID 116) |
| Created From | PO999001 (link to PO) |
| Memo | Dropship bill test |
| Item | 29S0100 |
| Qty | 2 |
| Rate | $68.81 |
| Amount | $137.62 |
| Location | Dropship |

---

## Linkage

SO `TEST-DS-BILL-001` → PO `PO999001` → Bill `PO999001-INV-DS-TEST-001`
