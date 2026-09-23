package com.example.bookshop

/** Prints a token signed with the development key, as an identity provider would issue one: `./gradlew -q token --args=staff` */
fun main(args: Array<String>) {
    val role = if (args.firstOrNull() == "staff") "staff" else "customer"
    println(devToken(if (role == "staff") "s1" else "u1", role))
}
