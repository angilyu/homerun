import XCTest
@testable import HomerunKit

final class NoiseTests: XCTestCase {
  /// The cacophony transcripts for Homerun's four patterns, byte for byte.
  func testCacophony() throws {
    let v = try Vectors.load("noise-cacophony")
    let cases = v["vectors"]!.array!
    XCTAssertGreaterThanOrEqual(cases.count, 4)
    for c in cases {
      let name = c["protocol_name"]!.string!
      let pname = name.split(separator: "_")[1]
      let pattern = try XCTUnwrap(Noise.Pattern(rawValue: String(pname)), name)
      func key(_ k: String) throws -> SoftwareX25519? { try c[k].map { try SoftwareX25519(secret: hex($0)) } }
      func psk(_ k: String) throws -> Data? { try c[k]?.array?.first.map { try hex($0) } }
      let initiator = try HandshakeState(pattern: pattern, initiator: true, prologue: hex(c["init_prologue"]), s: key("init_static"), rs: c["init_remote_static"].map { try hex($0) }, psk: psk("init_psks"), e: key("init_ephemeral"))
      let responder = try HandshakeState(pattern: pattern, initiator: false, prologue: hex(c["resp_prologue"]), s: key("resp_static"), rs: c["resp_remote_static"].map { try hex($0) }, psk: psk("resp_psks"), e: key("resp_ephemeral"))
      var transport: (TransportPair, TransportPair)?
      for (i, m) in c["messages"]!.array!.enumerated() {
        let payload = try hex(m["payload"])
        let expected = try hex(m["ciphertext"])
        if transport == nil {
          let (w, r) = i % 2 == 0 ? (initiator, responder) : (responder, initiator)
          let ct = try w.writeMessage(payload)
          XCTAssertEqual(Bytes.hex(ct), Bytes.hex(expected), "\(name) message \(i)")
          XCTAssertEqual(try r.readMessage(ct), payload)
          if initiator.finished {
            XCTAssertTrue(responder.finished)
            XCTAssertEqual(Bytes.hex(initiator.handshakeHash), c["handshake_hash"]!.string!, name)
            XCTAssertEqual(initiator.handshakeHash, responder.handshakeHash)
            transport = (try initiator.split(), try responder.split())
          }
        } else {
          let (ti, tr) = transport!
          // One-way patterns: only the initiator sends. Otherwise, alternate from the handshake's turn.
          let initiatorSends = pattern.oneWay || i % 2 == 0
          let (send, recv) = initiatorSends ? (ti.send!, tr.recv!) : (tr.send!, ti.recv!)
          let ct = try send.encrypt(ad: Data(), plaintext: payload)
          XCTAssertEqual(Bytes.hex(ct), Bytes.hex(expected), "\(name) transport \(i)")
          XCTAssertEqual(try recv.decrypt(ad: Data(), ciphertext: ct), payload)
        }
      }
    }
  }

  func testForgedMessageDoesNotAdvanceNonce() throws {
    let a = SoftwareX25519(), b = SoftwareX25519()
    let i = try HandshakeState(pattern: .K, initiator: true, prologue: Data(), s: a, rs: b.publicKey)
    let r = try HandshakeState(pattern: .K, initiator: false, prologue: Data(), s: b, rs: a.publicKey)
    _ = try r.readMessage(try i.writeMessage())
    let send = try i.split().send!, recv = try r.split().recv!
    let ct = try send.encrypt(ad: Data(), plaintext: Data("hi".utf8))
    var bad = ct
    bad[0] ^= 1
    XCTAssertThrowsError(try recv.decrypt(ad: Data(), ciphertext: bad))
    XCTAssertEqual(recv.nonce, 0)
    XCTAssertEqual(try recv.decrypt(ad: Data(), ciphertext: ct), Data("hi".utf8))
  }

  func testLowOrderPointRefused() throws {
    XCTAssertThrowsError(try SoftwareX25519().dh(Data(count: 32)))
  }
}
