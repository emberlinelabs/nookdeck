import Foundation

/// What to do with the agent on launch (spec A2). An existing install is adopted, never duplicated.
public enum InstallAction: Equatable {
    /// nothing installed: copy the bundled program, register the login service
    case install
    /// the program is there (a CLI install) but no login service points at it: register the service only
    case registerService
    /// the installed program is older than the bundled one: replace it, restart the service
    case update(from: String)
    /// everything is in place: leave it alone
    case adopt
}

public struct InstallFacts: Equatable {
    public var installedVersion: String?   // nil = no program at the usual place
    public var bundledVersion: String
    public var plistExists: Bool
    /// ProgramArguments[0] of the plist, when it exists
    public var plistProgram: String?
    public var installedPath: String

    public init(installedVersion: String?, bundledVersion: String, plistExists: Bool, plistProgram: String?, installedPath: String) {
        self.installedVersion = installedVersion; self.bundledVersion = bundledVersion
        self.plistExists = plistExists; self.plistProgram = plistProgram; self.installedPath = installedPath
    }
}

public func planInstall(_ f: InstallFacts) -> InstallAction {
    guard let have = f.installedVersion else { return .install }
    if !f.plistExists { return .registerService }
    // a service that runs some other program (a source checkout, Homebrew) is adopted as it is: its file is not ours to replace
    if let program = f.plistProgram, program != f.installedPath { return .adopt }
    if Version.compare(have, f.bundledVersion) < 0 { return .update(from: have) }
    return .adopt
}
