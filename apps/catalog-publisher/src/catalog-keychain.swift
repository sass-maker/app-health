import Foundation
import Security
import LocalAuthentication
import Darwin

let arguments = CommandLine.arguments
if arguments.count >= 5 && arguments[1] == "lock" {
    let descriptor = open(arguments[2], O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { exit(1) }
    guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { close(descriptor); exit(75) }
    setenv("APP_HEALTH_CATALOG_LOCKED", "1", 1)
    _ = fcntl(descriptor, F_SETFD, 0)
    var vector = arguments.dropFirst(3).map { strdup($0) }
    vector.append(nil)
    arguments[3].withCString { executable in
        vector.withUnsafeMutableBufferPointer { pointers in
            _ = execv(executable, pointers.baseAddress!)
        }
    }
    close(descriptor)
    exit(1)
}
guard arguments.count == 3, ["get", "put"].contains(arguments[1]) else { exit(2) }
let account = arguments[2]
guard UUID(uuidString: account) != nil else { exit(2) }
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "com.sassmaker.app-health.catalog-publisher",
    kSecAttrAccount as String: account,
]
if arguments[1] == "put" {
    let secret = FileHandle.standardInput.readDataToEndOfFile()
    guard secret.count == 69 else { exit(2) }
    var item = query
    item[kSecValueData as String] = secret
    item[kSecAttrLabel as String] = "App Health catalog publisher"
    let status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess else { exit(1) }
} else {
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    let context = LAContext()
    context.interactionNotAllowed = true
    lookup[kSecUseAuthenticationContext as String] = context
    var result: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &result)
    guard status == errSecSuccess, let value = result as? Data else { exit(1) }
    FileHandle.standardOutput.write(value)
}
