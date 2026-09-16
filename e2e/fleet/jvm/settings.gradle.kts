rootProject.name = "fleet-member"

// Built against the runtime next door, as the examples are, so nothing has to be published first.
includeBuild("../../../kotlin") {
    dependencySubstitution {
        substitute(module("dev.rayfold:rayfold-core")).using(project(":rayfold-core"))
        substitute(module("dev.rayfold:rayfold-jdbc")).using(project(":rayfold-jdbc"))
    }
}
