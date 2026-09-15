package com.example.bookshop;

import java.math.BigDecimal;

public record Book(String id, String title, int stock, String authorId, BigDecimal costPrice) {
    public Book withStock(int stock) {
        return new Book(id, title, stock, authorId, costPrice);
    }
}
