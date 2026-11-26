import XCTest
@testable import NookdeckCore

final class ReleaseNotesTests: XCTestCase {
    let body = """
    ## Nookdeck 0.6.1

    Upgrading: run the install command below again, or `nookdeck update`, or use **Install and restart** in the app.

    ### Fixed

    - **Windows: high CPU** ([#15](https://github.com/howznguyen/nookdeck/issues/15)). Now one check at a time.

    ## Nookdeck 0.6.0: Linux, and updates in one click

    Upgrading: run the install command below again.

    ### New

    - **Linux (experimental).** Ubuntu and Debian:
      - Install the `.deb` and open **Nookdeck**.
      - The install command works too.
    """

    func testOnlyTheSectionsNewerThanTheRunningApp() {
        let r = ReleaseNotes.newer(body, current: "0.6.0")
        XCTAssertEqual(r.shown.map(\.version), ["0.6.1"])
        XCTAssertFalse(r.more)
        XCTAssertNil(r.shown[0].title)
        XCTAssertFalse(r.shown[0].markdown.contains("Upgrading"))
        XCTAssertTrue(r.shown[0].markdown.hasPrefix("### Fixed"))
        XCTAssertEqual(ReleaseNotes.newer(body, current: "0.6.1").shown, [])
        XCTAssertEqual(ReleaseNotes.newer(body, current: "0.5.3").shown.map(\.version), ["0.6.1", "0.6.0"])
    }

    func testTitlesAfterAColon() {
        let s = ReleaseNotes.sections(body)
        XCTAssertEqual(s.map(\.version), ["0.6.1", "0.6.0"])
        XCTAssertEqual(s[1].title, "Linux, and updates in one click")
        XCTAssertFalse(s[1].markdown.contains("Upgrading"))
        XCTAssertNil(ReleaseNotes.heading("### Nookdeck 0.6.0"))
        XCTAssertNil(ReleaseNotes.heading("## What's new"))
        XCTAssertEqual(ReleaseNotes.heading("## Nookdeck v1.2.3: big one")?.version, "1.2.3")
    }

    func testPrereleasesAreIgnoredAndAtMostThreeAreShown() {
        let many = ["0.7.0-beta.1", "0.6.4", "0.6.3", "0.6.2", "0.6.1"].map { "## Nookdeck \($0)\n\n- item \($0)\n" }.joined(separator: "\n")
        let r = ReleaseNotes.newer(many, current: "0.6.0")
        XCTAssertEqual(r.shown.map(\.version), ["0.6.4", "0.6.3", "0.6.2"])
        XCTAssertTrue(r.more)
        XCTAssertEqual(ReleaseNotes.newer(many, current: "0.6.3").shown.map(\.version), ["0.6.4"])
        XCTAssertFalse(ReleaseNotes.newer(many, current: "0.6.3").more)
        // never newer than the version on offer: the latest body can already hold the next section
        XCTAssertEqual(ReleaseNotes.newer(many, current: "0.6.0", upTo: "0.6.2").shown.map(\.version), ["0.6.2", "0.6.1"])
        XCTAssertFalse(ReleaseNotes.newer(many, current: "0.6.0", upTo: "0.6.2").more)
        XCTAssertEqual(ReleaseNotes.newer(many, current: "0.6.0", upTo: "0.6.4").shown.map(\.version), ["0.6.4", "0.6.3", "0.6.2"])
        XCTAssertEqual(ReleaseNotes.newer(many, current: "0.6.4", upTo: "0.6.4").shown, [])
        XCTAssertEqual(ReleaseNotes.newer("", current: "0.6.0").shown, [])
        XCTAssertEqual(ReleaseNotes.newer("no sections at all", current: "0.6.0").shown, [])
    }

    func testMarkdownBlocks() {
        let s = ReleaseNotes.sections(body)[1].markdown
        let b = NotesMarkdown.blocks(s)
        XCTAssertEqual(b.count, 4)
        XCTAssertEqual(b[0], .heading(level: 3, [.text("New")]))
        XCTAssertEqual(b[1], .bullet(depth: 0, [.bold("Linux (experimental)."), .text(" Ubuntu and Debian:")]))
        XCTAssertEqual(b[2], .bullet(depth: 1, [.text("Install the "), .code(".deb"), .text(" and open "), .bold("Nookdeck"), .text(".")]))
        XCTAssertEqual(b[3], .bullet(depth: 1, [.text("The install command works too.")]))
        // a paragraph over two lines is one paragraph; a wrapped list line stays in its item
        XCTAssertEqual(NotesMarkdown.blocks("one\ntwo\n\nthree"), [.paragraph([.text("one two")]), .paragraph([.text("three")])])
        XCTAssertEqual(NotesMarkdown.blocks("- first\n  still first\n- second"), [.bullet(depth: 0, [.text("first still first")]), .bullet(depth: 0, [.text("second")])])
    }

    func testInlines() {
        let u = URL(string: "https://github.com/howznguyen/nookdeck/issues/15")!
        XCTAssertEqual(NotesMarkdown.inlines("see ([#15](https://github.com/howznguyen/nookdeck/issues/15))."), [.text("see ("), .link("#15", u), .text(").")])
        XCTAssertEqual(NotesMarkdown.inlines("[**Docs**](https://x.dev/a)"), [.link("Docs", URL(string: "https://x.dev/a")!)])
        // not a web link, unmatched markers: plain text
        XCTAssertEqual(NotesMarkdown.inlines("[x](javascript:alert(1))"), [.text("[x](javascript:alert(1))")])
        XCTAssertEqual(NotesMarkdown.inlines("a ** b ` c"), [.text("a ** b ` c")])
        XCTAssertEqual(NotesMarkdown.inlines("run `nookdeck update` now"), [.text("run "), .code("nookdeck update"), .text(" now")])
    }

    func testTheReleaseCarriesItsNotes() {
        let json = """
        {"tag_name":"v0.6.1","html_url":"https://github.com/howznguyen/nookdeck/releases/tag/v0.6.1","body":"## Nookdeck 0.6.1\\n\\n- fix","assets":[
          {"name":"Nookdeck.dmg","browser_download_url":"https://e.x/Nookdeck.dmg"},
          {"name":"Nookdeck.dmg.sha256","browser_download_url":"https://e.x/Nookdeck.dmg.sha256"}]}
        """
        let r = AppRelease.newer(json: Data(json.utf8), current: "0.6.0")
        XCTAssertEqual(r?.notes, "## Nookdeck 0.6.1\n\n- fix")
        XCTAssertEqual(r?.page?.absoluteString, "https://github.com/howznguyen/nookdeck/releases/tag/v0.6.1")
    }

    func testNotesFromTheReleasesList() {
        func rel(_ tag: String, _ body: String, draft: Bool = false, pre: Bool = false) -> [String: Any] {
            ["tag_name": tag, "draft": draft, "prerelease": pre, "body": body, "html_url": "https://github.com/howznguyen/nookdeck/releases/tag/\(tag)"]
        }
        let install = "\n\n## Install\n\n- run the command\n\n## Files\n\n- Nookdeck.dmg"
        let list: [[String: Any]] = [
            rel("v0.7.0", "## Nookdeck 0.7.0: pages\n\nUpgrading: again.\n\n- wrap-around pages" + install),
            rel("v0.7.0-beta.1", "## Nookdeck 0.7.0-beta.1\n\n- beta", pre: true),
            rel("v0.6.2", "## Nookdeck 0.6.2\n\n- draft fix", draft: true),
            rel("v0.6.1", "## Nookdeck 0.6.1\n\n### Fixed\n\n- **Windows** CPU" + install),
            rel("v0.6.0", "## Nookdeck 0.6.0: Linux\n\n- Linux" + install),
            rel("v0.5.3", "## Nookdeck 0.5.3\n\n- iOS 15"),
        ]
        let json = try! JSONSerialization.data(withJSONObject: list)

        // current 0.6.0, offered 0.6.1: only 0.6.1 (not the newer 0.7.0, not 0.6.0 itself)
        let a = ReleaseNotes.fromReleases(json: json, current: "0.6.0", upTo: "0.6.1")!
        XCTAssertEqual(a.shown.map(\.version), ["0.6.1"])
        XCTAssertFalse(a.more)
        XCTAssertTrue(a.shown[0].markdown.hasPrefix("### Fixed"))
        XCTAssertFalse(a.shown[0].markdown.contains("Install"), "the Install and Files parts are not notes")

        // current 0.5.2, offered 0.7.0: three newest published ones, more for 0.5.3; drafts and prereleases left out
        let b = ReleaseNotes.fromReleases(json: json, current: "0.5.2", upTo: "0.7.0")!
        XCTAssertEqual(b.shown.map(\.version), ["0.7.0", "0.6.1", "0.6.0"])
        XCTAssertEqual(b.shown[0].title, "pages")
        XCTAssertFalse(b.shown[0].markdown.contains("Upgrading"))
        XCTAssertTrue(b.more)
        XCTAssertFalse(ReleaseNotes.fromReleases(json: json, current: "0.5.3", upTo: "0.7.0")!.more)

        XCTAssertEqual(ReleaseNotes.fromReleases(json: json, current: "0.7.0", upTo: "0.7.0")!.shown, [])
        XCTAssertNil(ReleaseNotes.fromReleases(json: Data("{\"message\":\"rate limited\"}".utf8), current: "0.6.0", upTo: "0.6.1"))
    }
}
