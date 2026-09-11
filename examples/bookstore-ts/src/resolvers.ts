import { RayfoldError, ok, type Resolvers } from "@rayfold/server";
import { count, money, type BookRow, type OrderRow, type ReviewRow, type Store } from "./data.ts";
import { authorBookPages, bookPage, byId, page, type BookFilter, type PageArgs } from "./books.ts";

interface Viewer { id: string; role: "admin" | "customer" }
/** Resolvers over an in-memory store. Every entity-field loader is batch: one call per level. */
export function bookstoreResolvers(store: Store): Resolvers {
  return {
    Query: {
      books: (args: { filter: BookFilter | null; page: PageArgs }) => {
        count(store, "Query.books");
        return bookPage(store, args.filter, args.page);
      },
      book: (args: { id: string }) => {
        count(store, "Query.book");
        return store.books.get(args.id) ?? null;
      },
      author: (args: { id: string }) => {
        count(store, "Query.author");
        return store.authors.get(args.id) ?? null;
      },
      order: (args: { id: string }) => {
        count(store, "Query.order");
        return store.orders.get(args.id) ?? null;
      },
      review: (args: { id: string }) => {
        count(store, "Query.review");
        return store.reviews.get(args.id) ?? null;
      },
      myOrders: (args: { page: PageArgs }, ctx) => {
        count(store, "Query.myOrders");
        const v = ctx.viewer as Viewer;
        return page([...store.orders.values()].filter((o) => o.customerId === v.id).sort(byId), args.page);
      },
    },

    Command: {
      placeOrder: (args: { input: { lines: Array<{ bookId: string; qty: number }> } }, ctx) => {
        count(store, "Command.placeOrder");
        const v = ctx.viewer as Viewer;
        const items: OrderRow["items"] = [];
        let total = 0;
        for (const line of args.input.lines) {
          const b = store.books.get(line.bookId);
          if (!b) throw new RayfoldError("not_found", `Book ${line.bookId} not found`);
          if (b.stock < line.qty) throw RayfoldError.domain("OutOfStock", { bookId: b.id, available: b.stock }, `Only ${b.stock} of ${b.title} left`);
          items.push({ bookId: b.id, qty: line.qty, unitPrice: b.price });
          total += Number(b.price) * line.qty;
        }
        if (total > 500) throw RayfoldError.domain("PaymentDeclined", { reason: "limit" }, "Order exceeds the card limit");
        const order: OrderRow = { id: `o${ctx.simulate ? store.nextId : store.nextId++}`, status: "PLACED", customerId: v.id, items, total: money(total) };
        const patch: Array<{ set: string; value: Record<string, unknown> }> = [];
        const emit: Array<{ event: string; payload: Record<string, unknown> }> = [{ event: "OrderPlaced", payload: { orderId: order.id, customerId: v.id } }];
        // A simulated order reports the same effects as a real one; only the writes are skipped.
        if (!ctx.simulate) store.orders.set(order.id, order);
        for (const it of items) {
          const b = store.books.get(it.bookId)!;
          const stock = b.stock - it.qty;
          if (!ctx.simulate) b.stock = stock;
          patch.push({ set: `Book:${b.id}`, value: { stock } });
          emit.push({ event: "StockChanged", payload: { bookId: b.id, stock } });
        }
        return ok(order, { patch, emit });
      },
      cancelOrder: (args: { id: string }, ctx) => {
        count(store, "Command.cancelOrder");
        const v = ctx.viewer as Viewer;
        const o = store.orders.get(args.id);
        if (!o || (o.customerId !== v.id && v.role !== "admin")) throw new RayfoldError("not_found", `Order ${args.id} not found`);
        if (o.status !== "PLACED") throw RayfoldError.domain("NotCancellable", { status: o.status }, `Order is ${o.status}`);
        if (ctx.simulate) return { ...o, status: "CANCELLED" };
        o.status = "CANCELLED";
        for (const it of o.items) store.books.get(it.bookId)!.stock += it.qty;
        return ok(o, { patch: o.items.map((it) => ({ set: `Book:${it.bookId}`, value: { stock: store.books.get(it.bookId)!.stock } })) });
      },
      addReview: (args: { input: { bookId: string; rating: number; body: string } }, ctx) => {
        count(store, "Command.addReview");
        const v = ctx.viewer as Viewer;
        if (!store.books.has(args.input.bookId)) throw new RayfoldError("not_found", `Book ${args.input.bookId} not found`);
        if (args.input.rating < 1 || args.input.rating > 5) throw new RayfoldError("invalid_argument", "rating must be 1..5");
        const r: ReviewRow = { id: `r${ctx.simulate ? store.nextId : store.nextId++}`, rating: args.input.rating, body: args.input.body, bookId: args.input.bookId, reviewerId: v.id, version: 1 };
        if (!ctx.simulate) store.reviews.set(r.id, r);
        return ok(r, { patch: [{ invOp: ["books"] }] });
      },
      payOrder: (args: { id: string }, ctx) => {
        count(store, "Command.payOrder");
        const v = ctx.viewer as Viewer;
        const o = store.orders.get(args.id);
        if (!o || (o.customerId !== v.id && v.role !== "admin")) throw new RayfoldError("not_found", `Order ${args.id} not found`);
        if (o.status !== "PLACED") throw RayfoldError.domain("NotPayable", { status: o.status }, `Order is ${o.status}`);
        if (Number(o.total) > 400) throw RayfoldError.domain("PaymentDeclined", { reason: "limit" }, "Payment exceeds the card limit");
        if (ctx.simulate) return { ...o, status: "PAID" };
        o.status = "PAID";
        return ok(o);
      },
      editReview: (args: { id: string; input: { rating: number; body: string } }, ctx) => {
        count(store, "Command.editReview");
        const v = ctx.viewer as Viewer;
        const r = store.reviews.get(args.id);
        if (!r) throw new RayfoldError("not_found", `Review ${args.id} not found`);
        if (r.reviewerId !== v.id && v.role !== "admin") throw new RayfoldError("permission_denied", "Only the author of a review can edit it");
        ctx.checkVersion(`Review:${r.id}`, r.version, r);
        const next = { ...r, rating: args.input.rating, body: args.input.body, version: r.version + 1 };
        if (!ctx.simulate) store.reviews.set(r.id, next);
        return ok(next);
      },
      updateBook: (args: { id: string; patch: Partial<Record<"title" | "price" | "stock", string | number | null>> }, ctx) => {
        count(store, "Command.updateBook");
        const b = store.books.get(args.id);
        if (!b) throw new RayfoldError("not_found", `Book ${args.id} not found`);
        for (const [k, val] of Object.entries(args.patch)) if (val === null) throw new RayfoldError("invalid_argument", `updateBook().patch.${k}: cannot be cleared`);
        const next: BookRow = { ...b, ...(args.patch as Partial<BookRow>) };
        if (!ctx.simulate) store.books.set(b.id, next);
        return ok(next);
      },
      deleteReview: (args: { id: string }, ctx) => {
        count(store, "Command.deleteReview");
        const v = ctx.viewer as Viewer;
        const r = store.reviews.get(args.id);
        if (!r) throw new RayfoldError("not_found", `Review ${args.id} not found`);
        if (r.reviewerId !== v.id && v.role !== "admin") throw new RayfoldError("permission_denied", "Only the author of a review can delete it");
        if (!ctx.simulate) store.reviews.delete(r.id);
        return ok(r, { patch: [{ del: `Review:${r.id}` }] });
      },
      restock: (args: { bookId: string; qty: number }, ctx) => {
        count(store, "Command.restock");
        const b = store.books.get(args.bookId);
        if (!b) throw new RayfoldError("not_found", `Book ${args.bookId} not found`);
        if (ctx.simulate) return { ...b, stock: b.stock + args.qty };
        b.stock += args.qty;
        return ok(b, { emit: [{ event: "StockChanged", payload: { bookId: b.id, stock: b.stock } }] });
      },
    },

    Stream: {
      stockUpdates: (args: { bookIds: string[] }, ctx) => {
        count(store, "Stream.stockUpdates");
        const wanted = new Set(args.bookIds);
        const source = ctx.events.subscribe<{ bookId: string; stock: number }>("StockChanged", ctx.signal);
        return (async function* () {
          for await (const ev of source) if (wanted.has(ev.bookId)) yield ev;
        })();
      },
    },

    Book: {
      author: (parents: BookRow[]) => {
        count(store, "Book.author");
        return parents.map((b) => store.authors.get(b.authorId) ?? null);
      },
      reviews: (parents: BookRow[], args: { page: PageArgs }) => {
        count(store, "Book.reviews");
        const all = [...store.reviews.values()].sort(byId);
        return parents.map((b) => page(all.filter((r) => r.bookId === b.id), args.page));
      },
    },
    Author: {
      books: (parents: Array<{ id: string }>, args: { page: PageArgs }) => {
        count(store, "Author.books");
        return authorBookPages(store, parents.map((a) => a.id), args.page);
      },
    },
    Review: {
      book: (parents: ReviewRow[]) => {
        count(store, "Review.book");
        return parents.map((r) => store.books.get(r.bookId) ?? null);
      },
    },
    OrderItem: {
      book: (parents: Array<{ bookId: string }>) => {
        count(store, "OrderItem.book");
        return parents.map((i) => store.books.get(i.bookId) ?? null);
      },
    },
  } as Resolvers;
}
