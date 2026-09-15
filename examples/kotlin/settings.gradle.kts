rootProject.name = "bookshop"

// Inside the Rayfold repository, build against the runtime next door so nothing has to be published first.
// A copy of this project outside the repository drops this block and resolves the artifacts from Maven Central.
includeBuild("../../kotlin") {
    dependencySubstitution {
        substitute(module("dev.rayfold:rayfold-core")).using(project(":rayfold-core"))
        substitute(module("dev.rayfold:rayfold-client")).using(project(":rayfold-client"))
    }
}
