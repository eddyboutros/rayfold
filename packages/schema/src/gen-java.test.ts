import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bookstoreSchemaText } from "../../../examples/bookstore-ts/src/index.ts";
import { generateJava, loadSchema } from "./index.ts";

// The generated Java is compiled with javac and run, when a JDK is on PATH. CI sets REQUIRE_JAVAC=1 so a missing JDK
// fails the run there instead of skipping these tests.
const javac = (() => {
  try {
    execFileSync("javac", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
if (!javac && process.env["REQUIRE_JAVAC"]) throw new Error("REQUIRE_JAVAC is set but javac is not on PATH");

const work = mkdtempSync(join(tmpdir(), "rayfold-gen-java-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Compiles `sources` (path -> text) into `<dir>/out` with javac; returns the class output folder. */
function compile(name: string, sources: Record<string, string>): string {
  const dir = join(work, name);
  const files = Object.entries(sources).map(([path, text]) => {
    const file = join(dir, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
    return file;
  });
  execFileSync("javac", ["-Xlint:all", "-Werror", "-d", join(dir, "out"), ...files], { stdio: "pipe" });
  return join(dir, "out");
}

const PETS = `
"""Something with a name."""
object Named @interface { name: String }
entity Cat implements Named { id: ID name: String lives: Int }
"""
A dog.
Two lines of description.
"""
entity Dog implements Named {
  id: ID
  name: String
  """Java keyword as a field name."""
  class: String
  default: Boolean?
}
object Photo { url: String width: Int? }
union Pet = Cat | Dog
union Media = Photo | Cat
enum Size { SMALL LARGE }
scalar Email
error Gone { since: Instant }
event Adopted { petId: ID contact: Email }
input PetFilter { size: Size? names: [String]? }
query pets(filter: PetFilter?, page: PageArgs = { first: 10 }): Page<Pet>
query media: [Media]
command adoptPet(petId: ID): Pet throws Gone emits Adopted
stream feed: Adopted
`;

describe("rayfold gen java", () => {
  it("writes one class with records, enums, Page and the operations of the bookstore", () => {
    const src = generateJava(loadSchema(bookstoreSchemaText()).ir, { pkg: "shop.api", className: "Bookstore" });
    expect(src).toContain("package shop.api;");
    expect(src).toContain("public final class Bookstore {");
    expect(src).toContain("public record Book(String id, String title, Format format, String price, Integer stock, Author author, Page<Review> reviews, String costPrice, String ownerId) {}");
    expect(src).toContain("public enum Format { HARDCOVER, PAPERBACK, EBOOK }");
    expect(src).toContain('public static final String PLACE_ORDER = "placeOrder";');
    expect(src).toContain("public record PlaceOrderArgs(OrderInput input) {}");
    // descriptions become Javadoc, field descriptions @param tags
    expect(src).toMatch(/@param price Unit price in the store currency\./);
  });

  it.runIf(javac)("compiles cleanly and runs: union members carry $type, Java keywords are escaped, other names are not", () => {
    const main = `package demo;
import java.util.List;
public class Main {
  public static void main(String[] args) {
    Api.Cat cat = new Api.Cat("c1", "Tom", 9);
    Api.Dog dog = new Api.Dog("d1", "Rex", "big", true);
    Api.Pet pet = cat;
    Api.Page<Api.Pet> page = new Api.Page<>(List.of(cat, dog), null, false, 2);
    System.out.println(String.join(" ", cat.$type(), dog.$type(), dog.class_(), String.valueOf(dog.default_()), dog.name(),
      String.valueOf(page.items().size()), Api.Ops.ADOPT_PET, Api.Ops.PETS, Api.Size.LARGE.name(), String.valueOf(pet instanceof Api.Media),
      new Api.Ops.AdoptPetArgs("c1").petId(), new Api.Photo("u", null).$type(), new Api.Adopted("c1", "a@b.c").contact(), new Api.Gone("2026-09-10T00:00:00Z").since()));
  }
}
`;
    const out = compile("pets", { "demo/Api.java": generateJava(loadSchema(PETS).ir, { pkg: "demo", className: "Api" }), "demo/Main.java": main });
    expect(execFileSync("java", ["-cp", out, "demo.Main"], { encoding: "utf8" }).trim()).toBe("Cat Dog big true Rex 2 adoptPet pets LARGE true c1 Photo a@b.c 2026-09-10T00:00:00Z");
  });

  it.runIf(javac)("every schema in the repository generates Java that compiles without warnings", () => {
    const fixtures = join(__dirname, "../../../conformance/fixtures/core");
    const schemas: Array<[string, string]> = [["bookstore", bookstoreSchemaText()], ["pets", PETS]];
    for (const f of readdirSync(fixtures).sort()) schemas.push([f, (JSON.parse(readFileSync(join(fixtures, f), "utf8")) as { schema: string }).schema]);
    const sources: Record<string, string> = {};
    schemas.forEach(([, text], i) => (sources[`p${i}/Schema.java`] = generateJava(loadSchema(text).ir, { pkg: `p${i}`, className: "Schema" })));
    compile("all", sources);
    expect(Object.keys(sources)).toHaveLength(schemas.length);
  });
});
