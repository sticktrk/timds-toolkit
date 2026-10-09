// Public snapshot-schema fixtures, including Git asset order and JSON order.
export function publicationFixture(schemaVersion = 2) {
  return {
    manifest: { schemaVersion: 2, systemId: "example/core", name: " Example ", version: "1.2.3", defaultTheme: " dark ", themes: [" dark ", "light"], description: " Notes ", artifact: { entry: "viewer/index.html", publishRef: "timds-published" }, nav: [{ id: "Digital DS", pages: [{ slug: "Color & Shape", title: " Colors ", group: " Foundation " }] }], workspace: { build: ["ignored"] } },
    tokens: { schemaVersion: 1, colors: { accent: "#abc", ink: "#123" } },
    media: { schemaVersion, assets: [{ id: "asset_123", key: "Brand.Mark", bytes: 12, sha256: "A".repeat(64), filename: " mark.svg ", kind: "image", publicUrl: "https://cdn.example.com/mark.svg", visibility: "public", rights: { status: "client-owned", notes: " OK ", attribution: " Credit ", expiresOn: "" }, tags: [" logo ", ""], title: " Mark " }] },
    sourceFiles: [
      { path: "assets/Z.svg", bytes: 4 }, { path: "assets/a.pdf", bytes: 5 },
      { path: "components/button.json", content: '{"name":"Button","nested":{"x":1}}' },
      { path: "docs/brand/color.mdx", content: "# Color\n\nCafé palette.\n" },
      { path: "docs/getting-started.md", content: "No heading.\n" },
    ],
    artifactFiles: [{ path: "viewer/index.html", content: Buffer.from("<h1>Example</h1>") }, { path: "bundle.json", content: Buffer.from('{"schemaVersion":1}') }, { path: "viewer/styles.css", content: Buffer.from(":root{--color:#abc}") }],
  };
}
