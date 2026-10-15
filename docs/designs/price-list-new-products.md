# New products from a supplier price list

Status: built (2026-10-15). TODOS.md "New products from a supplier price list". Builds on supplier price lists (PR #12).

## Problem
A price list that mentions a product we don't stock lists the SKU and stops there: there's no way to start stocking it.

## Decisions
1. **Add from the preview.** Each SKU not in the catalogue gets an "Add to catalogue" checkbox. Ticking it asks for what a
   price list doesn't carry: the category and that category's details (dimensions, safety standard, age range…), and
   whether units are batch-tracked (defaults by category, as seeded: cots, prams, monitors yes; clothing, toys no).
   Name, price and supplier come from the list. The new product is its own variant group (parentSku = SKU).
2. **One command.** Applying the list makes its changes and adds the ticked products in one transaction, recorded on the
   import (`added`). Adding is allowed with no price changes.
3. **SKUs are checked across the whole catalogue**, not just this supplier: an SKU another supplier already uses is
   refused (`SKU_TAKEN`). New SKUs are letters, digits, `.`, `_` and `-`, up to 40 characters.
4. **Demo guards.** At most 20 new products per list; they carry `createdOrigin: "visitor"` and the nightly reset deletes
   them (with the visitor stock, orders and batches that reference them, already removed by the reset). The catalogue
   rate budget applies as for price lists.

## Out of scope
Grouping a new SKU under an existing parent, editing products later, stock policies for new products.
