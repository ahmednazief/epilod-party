use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};

pub fn ed25519_public_key_from_seed(seed: &[u8; 32]) -> [u8; 32] {
    let signing_key = SigningKey::from_bytes(seed);
    signing_key.verifying_key().to_bytes()
}

pub fn ed25519_sign(seed: &[u8; 32], message: &[u8]) -> ([u8; 32], [u8; 64]) {
    let signing_key = SigningKey::from_bytes(seed);
    let pubkey = signing_key.verifying_key().to_bytes();
    let sig = signing_key.sign(message).to_bytes();
    (pubkey, sig)
}

pub fn ed25519_verify(
    pubkey: &[u8; 32],
    message: &[u8],
    signature: &[u8; 64],
) -> Result<(), &'static str> {
    let verifying_key =
        VerifyingKey::from_bytes(pubkey).map_err(|_| "Invalid Ed25519 public key encoding")?;
    if verifying_key.is_weak() {
        return Err("Small-order Ed25519 public key rejected");
    }
    let sig = Signature::from_bytes(signature);
    verifying_key
        .verify_strict(message, &sig)
        .map_err(|_| "Ed25519 signature verification failed")
}

pub fn decode_hex_fixed<const N: usize>(hex: &str) -> Result<[u8; N], &'static str> {
    let clean = hex.trim();
    if clean.len() != N * 2 {
        return Err("Unexpected hex length");
    }
    let bytes = clean.as_bytes();
    let mut out = [0u8; N];
    for (i, dst) in out.iter_mut().enumerate() {
        let s = std::str::from_utf8(&bytes[i * 2..i * 2 + 2]).map_err(|_| "Non-ASCII hex")?;
        *dst = u8::from_str_radix(s, 16).map_err(|_| "Invalid hex character")?;
    }
    Ok(out)
}

pub fn encode_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 8032 Section 7.1 official test vectors 1, 2, 3.
    #[test]
    fn rfc8032_section_7_1_vectors_match_and_verify() {
        // TEST 1: empty message
        let seed1 = decode_hex_fixed::<32>(
            "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
        )
        .unwrap();
        let expected_pk1 = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
        let expected_sig1 = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
        let (pk1, sig1) = ed25519_sign(&seed1, b"");
        assert_eq!(encode_hex(&pk1), expected_pk1);
        assert_eq!(encode_hex(&sig1), expected_sig1);
        assert!(ed25519_verify(&pk1, b"", &sig1).is_ok());

        // TEST 2: 1-byte message 0x72
        let seed2 = decode_hex_fixed::<32>(
            "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
        )
        .unwrap();
        let expected_pk2 = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
        let expected_sig2 = "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00";
        let (pk2, sig2) = ed25519_sign(&seed2, &[0x72]);
        assert_eq!(encode_hex(&pk2), expected_pk2);
        assert_eq!(encode_hex(&sig2), expected_sig2);
        assert!(ed25519_verify(&pk2, &[0x72], &sig2).is_ok());

        // TEST 3: 2-byte message 0xaf, 0x82
        let seed3 = decode_hex_fixed::<32>(
            "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
        )
        .unwrap();
        let expected_pk3 = "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025";
        let expected_sig3 = "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a";
        let (pk3, sig3) = ed25519_sign(&seed3, &[0xaf, 0x82]);
        assert_eq!(encode_hex(&pk3), expected_pk3);
        assert_eq!(encode_hex(&sig3), expected_sig3);
        assert!(ed25519_verify(&pk3, &[0xaf, 0x82], &sig3).is_ok());

        // Tamper rejection
        assert!(ed25519_verify(&pk3, &[0xaf, 0x83], &sig3).is_err());
        let mut tampered_sig = sig3;
        tampered_sig[63] ^= 1;
        assert!(ed25519_verify(&pk3, &[0xaf, 0x82], &tampered_sig).is_err());

        // Reject S >= L (malleability)
        let mut non_canon_sig = sig1;
        non_canon_sig[63] = 0xff;
        assert!(ed25519_verify(&pk1, b"", &non_canon_sig).is_err());

        // Reject small-order / identity public key forgery: (pk = Identity, R = Identity, S = 0)
        let mut id_pt = [0u8; 32];
        id_pt[0] = 1;
        let mut forged_sig = [0u8; 64];
        forged_sig[0] = 1;
        assert!(ed25519_verify(&id_pt, b"arbitrary message", &forged_sig).is_err());
    }
}
