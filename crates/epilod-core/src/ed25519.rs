use sha2::{Digest, Sha512};

/// Field prime p = 2^255 - 19 in little-endian 64-bit limbs.
const P: [u64; 4] = [
    0xffff_ffff_ffff_ffed,
    0xffff_ffff_ffff_ffff,
    0xffff_ffff_ffff_ffff,
    0x7fff_ffff_ffff_ffff,
];

/// Group order L = 2^252 + 27742317777372353535851937790883648493 in little-endian 64-bit limbs.
const L: [u64; 4] = [
    0x5812_631a_5cf5_d3ed,
    0x14de_f9de_a2f7_9cd6,
    0x0000_0000_0000_0000,
    0x1000_0000_0000_0000,
];

/// Canonical 256-bit field element in GF(2^255 - 19), stored as little-endian `[u64; 4]` in `[0, p)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Fe([u64; 4]);

impl Fe {
    const ZERO: Self = Self([0, 0, 0, 0]);
    const ONE: Self = Self([1, 0, 0, 0]);

    fn from_u64(v: u64) -> Self {
        Self([v, 0, 0, 0]).reduce_p()
    }

    fn from_le_bytes_masked(bytes: &[u8; 32]) -> Result<Self, &'static str> {
        let mut limbs = [0u64; 4];
        for (i, limb) in limbs.iter_mut().enumerate() {
            let off = i * 8;
            *limb = u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap());
        }
        limbs[3] &= 0x7fff_ffff_ffff_ffff;
        if cmp_256(&limbs, &P) != std::cmp::Ordering::Less {
            return Err("Non-canonical field encoding");
        }
        Ok(Self(limbs))
    }

    fn to_le_bytes(self) -> [u8; 32] {
        let n = self.reduce_p();
        let mut out = [0u8; 32];
        for (i, &limb) in n.0.iter().enumerate() {
            out[i * 8..i * 8 + 8].copy_from_slice(&limb.to_le_bytes());
        }
        out
    }

    fn is_zero(self) -> bool {
        let n = self.reduce_p();
        n.0 == [0, 0, 0, 0]
    }

    fn is_odd(self) -> bool {
        let n = self.reduce_p();
        (n.0[0] & 1) == 1
    }

    fn reduce_p(mut self) -> Self {
        if cmp_256(&self.0, &P) != std::cmp::Ordering::Less {
            self.0 = sub_256(&self.0, &P);
        }
        if cmp_256(&self.0, &P) != std::cmp::Ordering::Less {
            self.0 = sub_256(&self.0, &P);
        }
        self
    }

    fn add(self, rhs: Self) -> Self {
        let (sum, carry) = add_256(&self.0, &rhs.0);
        if carry || cmp_256(&sum, &P) != std::cmp::Ordering::Less {
            Self(sub_256_borrow_wrap(&sum, &P, carry)).reduce_p()
        } else {
            Self(sum)
        }
    }

    fn sub(self, rhs: Self) -> Self {
        if cmp_256(&self.0, &rhs.0) != std::cmp::Ordering::Less {
            Self(sub_256(&self.0, &rhs.0))
        } else {
            // self + (P - rhs)
            let p_minus_rhs = sub_256(&P, &rhs.0);
            self.add(Self(p_minus_rhs))
        }
    }

    fn neg(self) -> Self {
        if self.is_zero() {
            Self::ZERO
        } else {
            Self(sub_256(&P, &self.0))
        }
    }

    fn mul(self, rhs: Self) -> Self {
        // 512-bit product in [u64; 8]
        let mut prod = [0u64; 8];
        for i in 0..4 {
            let mut carry = 0u128;
            for j in 0..4 {
                let acc = (self.0[i] as u128) * (rhs.0[j] as u128) + (prod[i + j] as u128) + carry;
                prod[i + j] = acc as u64;
                carry = acc >> 64;
            }
            prod[i + 4] = carry as u64;
        }

        // Reduce 2^256 == 38 (mod p = 2^255 - 19): low + 38 * high
        let mut acc = [0u128; 5];
        for i in 0..4 {
            acc[i] = (prod[i] as u128) + 38u128 * (prod[i + 4] as u128);
        }
        let mut carry = 0u128;
        for cell in acc.iter_mut().take(4) {
            let total = *cell + carry;
            *cell = total & 0xffff_ffff_ffff_ffff;
            carry = total >> 64;
        }
        acc[4] = carry; // <= 38

        // Fold acc[4] * 38 back into limb 0
        let mut res = [0u64; 4];
        let mut fold = acc[4] * 38u128;
        for i in 0..4 {
            let total = acc[i] + fold;
            res[i] = total as u64;
            fold = total >> 64;
        }
        // If fold is still non-zero (at most 1), fold * 38 fits into res without wrap since p = 2^255 - 19
        if fold > 0 {
            let mut f = fold * 38u128;
            for limb in res.iter_mut() {
                let total = (*limb as u128) + f;
                *limb = total as u64;
                f = total >> 64;
            }
        }
        Self(res).reduce_p()
    }

    fn sq(self) -> Self {
        self.mul(self)
    }

    fn pow_bytes_le(self, exp_le: &[u8; 32]) -> Self {
        let mut res = Self::ONE;
        let mut base = self;
        for &byte in exp_le {
            for bit in 0..8 {
                if ((byte >> bit) & 1) == 1 {
                    res = res.mul(base);
                }
                base = base.sq();
            }
        }
        res
    }

    fn invert(self) -> Self {
        // p - 2 = 2^255 - 21
        let mut exp = [0xffu8; 32];
        exp[0] = 0xeb; // 0xff - 20 = 0xeb (since P[0] = 0xed, P-2 ends in 0xeb)
        exp[31] = 0x7f;
        self.pow_bytes_le(&exp)
    }

    fn pow_p58(self) -> Self {
        // (p - 5) / 8 = 2^252 - 3
        let mut exp = [0xffu8; 32];
        exp[0] = 0xfd;
        exp[31] = 0x0f;
        self.pow_bytes_le(&exp)
    }
}

fn cmp_256(a: &[u64; 4], b: &[u64; 4]) -> std::cmp::Ordering {
    for i in (0..4).rev() {
        match a[i].cmp(&b[i]) {
            std::cmp::Ordering::Equal => continue,
            ord => return ord,
        }
    }
    std::cmp::Ordering::Equal
}

fn add_256(a: &[u64; 4], b: &[u64; 4]) -> ([u64; 4], bool) {
    let mut out = [0u64; 4];
    let mut carry = 0u128;
    for i in 0..4 {
        let sum = (a[i] as u128) + (b[i] as u128) + carry;
        out[i] = sum as u64;
        carry = sum >> 64;
    }
    (out, carry != 0)
}

fn sub_256(a: &[u64; 4], b: &[u64; 4]) -> [u64; 4] {
    let mut out = [0u64; 4];
    let mut borrow = 0u128;
    for i in 0..4 {
        let ai = a[i] as u128;
        let bi = (b[i] as u128) + borrow;
        if ai >= bi {
            out[i] = (ai - bi) as u64;
            borrow = 0;
        } else {
            out[i] = ((1u128 << 64) + ai - bi) as u64;
            borrow = 1;
        }
    }
    out
}

fn sub_256_borrow_wrap(a: &[u64; 4], b: &[u64; 4], a_has_carry_bit: bool) -> [u64; 4] {
    if !a_has_carry_bit {
        return sub_256(a, b);
    }
    // Computes (2^256 + a) - b; since b = P < 2^255, result fits in 256+ bits,
    // and reducing modulo P again handles any high bit cleanly.
    let mut out = [0u64; 4];
    let mut borrow = 0u128;
    for i in 0..4 {
        let ai = a[i] as u128;
        let bi = (b[i] as u128) + borrow;
        if ai >= bi {
            out[i] = (ai - bi) as u64;
            borrow = 0;
        } else {
            out[i] = ((1u128 << 64) + ai - bi) as u64;
            borrow = 1;
        }
    }
    // Remaining carry bit 2^256 minus borrow=1 gives 0; if borrow=0, 2^256 remains which is 38 mod p
    if borrow == 0 {
        let (added, _) = add_256(&out, &[38, 0, 0, 0]);
        return added;
    }
    out
}

fn fe_d() -> Fe {
    // d = -121665 / 121666 mod p
    let num = Fe::from_u64(121_665).neg();
    let den = Fe::from_u64(121_666).invert();
    num.mul(den)
}

fn fe_sqrt_m1() -> Fe {
    // sqrt(-1) = 2^((p - 1) / 4) mod p; (p - 1)/4 = 2^253 - 5
    let mut exp = [0xffu8; 32];
    exp[0] = 0xfb;
    exp[31] = 0x1f;
    Fe::from_u64(2).pow_bytes_le(&exp)
}

fn recover_x(y: Fe, x_sign: bool) -> Result<Fe, &'static str> {
    let d = fe_d();
    let y2 = y.sq();
    let u = y2.sub(Fe::ONE);
    let v = d.mul(y2).add(Fe::ONE);
    let v3 = v.sq().mul(v);
    let v7 = v3.sq().mul(v);
    let uv3 = u.mul(v3);
    let uv7 = u.mul(v7);

    let mut x = uv3.mul(uv7.pow_p58());
    let vx2 = v.mul(x.sq());
    if vx2 != u {
        if vx2 == u.neg() {
            x = x.mul(fe_sqrt_m1());
        } else {
            return Err("Point is not on Ed25519 curve");
        }
    }
    if x.is_zero() && x_sign {
        return Err("Invalid zero x-coordinate with negative sign");
    }
    if x.is_odd() != x_sign {
        x = x.neg();
    }
    Ok(x)
}

#[derive(Clone, Copy)]
struct ExtPoint {
    x: Fe,
    y: Fe,
    z: Fe,
    t: Fe,
}

impl ExtPoint {
    const IDENTITY: Self = Self {
        x: Fe::ZERO,
        y: Fe::ONE,
        z: Fe::ONE,
        t: Fe::ZERO,
    };

    fn base_point() -> Self {
        let four = Fe::from_u64(4);
        let five_inv = Fe::from_u64(5).invert();
        let y = four.mul(five_inv);
        let x = recover_x(y, false).expect("RFC 8032 base point y=4/5");
        let t = x.mul(y);
        Self {
            x,
            y,
            z: Fe::ONE,
            t,
        }
    }

    fn add(self, other: Self, two_d: Fe) -> Self {
        let a = self.y.sub(self.x).mul(other.y.sub(other.x));
        let b = self.y.add(self.x).mul(other.y.add(other.x));
        let c = two_d.mul(self.t).mul(other.t);
        let d = self.z.mul(other.z);
        let d = d.add(d);
        let e = b.sub(a);
        let f = d.sub(c);
        let g = d.add(c);
        let h = b.add(a);
        Self {
            x: e.mul(f),
            y: g.mul(h),
            z: f.mul(g),
            t: e.mul(h),
        }
    }

    fn compress(self) -> [u8; 32] {
        let z_inv = self.z.invert();
        let x = self.x.mul(z_inv);
        let y = self.y.mul(z_inv);
        let mut bytes = y.to_le_bytes();
        if x.is_odd() {
            bytes[31] |= 0x80;
        }
        bytes
    }

    fn decompress(bytes: &[u8; 32]) -> Result<Self, &'static str> {
        let x_sign = (bytes[31] & 0x80) != 0;
        let y = Fe::from_le_bytes_masked(bytes)?;
        let x = recover_x(y, x_sign)?;
        let t = x.mul(y);
        Ok(Self {
            x,
            y,
            z: Fe::ONE,
            t,
        })
    }

    fn scalar_mul(self, scalar_le: &[u8; 32]) -> Self {
        let two_d = fe_d();
        let two_d = two_d.add(two_d);
        let mut acc = Self::IDENTITY;
        let mut cur = self;
        for &byte in scalar_le {
            for bit in 0..8 {
                if ((byte >> bit) & 1) == 1 {
                    acc = acc.add(cur, two_d);
                }
                cur = cur.add(cur, two_d);
            }
        }
        acc
    }

    fn equals(self, other: Self) -> bool {
        self.x.mul(other.z) == other.x.mul(self.z) && self.y.mul(other.z) == other.y.mul(self.z)
    }
}

/// Reduces a 64-byte little-endian integer modulo the Ed25519 subgroup order L.
fn mod_l_64(bytes: &[u8; 64]) -> [u8; 32] {
    // Accumulator of 5 limbs (up to 320 bits) shifted left one bit at a time.
    let mut rem = [0u64; 5];
    for byte_idx in (0..64).rev() {
        let b = bytes[byte_idx];
        for bit in (0..8).rev() {
            // rem = (rem << 1) | bit_val
            let mut carry = ((b >> bit) & 1) as u64;
            for limb in rem.iter_mut() {
                let next_carry = *limb >> 63;
                *limb = (*limb << 1) | carry;
                carry = next_carry;
            }
            // If rem >= L, rem -= L
            if cmp_320_l(&rem) != std::cmp::Ordering::Less {
                sub_320_l(&mut rem);
            }
        }
    }
    let mut out = [0u8; 32];
    for (i, &limb) in rem.iter().take(4).enumerate() {
        out[i * 8..i * 8 + 8].copy_from_slice(&limb.to_le_bytes());
    }
    out
}

fn cmp_320_l(a: &[u64; 5]) -> std::cmp::Ordering {
    if a[4] > 0 {
        return std::cmp::Ordering::Greater;
    }
    for i in (0..4).rev() {
        match a[i].cmp(&L[i]) {
            std::cmp::Ordering::Equal => continue,
            ord => return ord,
        }
    }
    std::cmp::Ordering::Equal
}

fn sub_320_l(a: &mut [u64; 5]) {
    let mut borrow = 0u128;
    for i in 0..5 {
        let li = if i < 4 { L[i] as u128 } else { 0 };
        let ai = a[i] as u128;
        let sub = li + borrow;
        if ai >= sub {
            a[i] = (ai - sub) as u64;
            borrow = 0;
        } else {
            a[i] = ((1u128 << 64) + ai - sub) as u64;
            borrow = 1;
        }
    }
}

fn is_canonical_scalar(bytes: &[u8; 32]) -> bool {
    let mut limbs = [0u64; 4];
    for (i, limb) in limbs.iter_mut().enumerate() {
        let off = i * 8;
        *limb = u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap());
    }
    cmp_256(&limbs, &L) == std::cmp::Ordering::Less
}

/// Computes `(a + b * c) mod L` by converting into a 64-byte LE product buffer.
fn add_mul_mod_l(a: &[u8; 32], b: &[u8; 32], c: &[u8; 32]) -> [u8; 32] {
    let mut wide = [0u8; 64];
    let mut al = [0u64; 4];
    let mut bl = [0u64; 4];
    let mut cl = [0u64; 4];
    for i in 0..4 {
        let off = i * 8;
        al[i] = u64::from_le_bytes(a[off..off + 8].try_into().unwrap());
        bl[i] = u64::from_le_bytes(b[off..off + 8].try_into().unwrap());
        cl[i] = u64::from_le_bytes(c[off..off + 8].try_into().unwrap());
    }

    let mut prod = [0u64; 8];
    for i in 0..4 {
        let mut carry = 0u128;
        for j in 0..4 {
            let acc = (bl[i] as u128) * (cl[j] as u128) + (prod[i + j] as u128) + carry;
            prod[i + j] = acc as u64;
            carry = acc >> 64;
        }
        prod[i + 4] = carry as u64;
    }

    let mut carry = 0u128;
    for i in 0..8 {
        let av = if i < 4 { al[i] as u128 } else { 0 };
        let acc = (prod[i] as u128) + av + carry;
        prod[i] = acc as u64;
        carry = acc >> 64;
    }

    for (i, &limb) in prod.iter().enumerate() {
        wide[i * 8..i * 8 + 8].copy_from_slice(&limb.to_le_bytes());
    }
    mod_l_64(&wide)
}

fn clamp_scalar(raw: &[u8]) -> [u8; 32] {
    let mut a = [0u8; 32];
    a.copy_from_slice(&raw[..32]);
    a[0] &= 248;
    a[31] &= 127;
    a[31] |= 64;
    a
}

pub fn ed25519_public_key_from_seed(seed: &[u8; 32]) -> [u8; 32] {
    let h = Sha512::digest(seed);
    let a = clamp_scalar(&h[..32]);
    ExtPoint::base_point().scalar_mul(&a).compress()
}

pub fn ed25519_sign(seed: &[u8; 32], message: &[u8]) -> ([u8; 32], [u8; 64]) {
    let h = Sha512::digest(seed);
    let a = clamp_scalar(&h[..32]);
    let prefix = &h[32..64];

    let base = ExtPoint::base_point();
    let pubkey = base.scalar_mul(&a).compress();

    let mut r_hasher = Sha512::new();
    r_hasher.update(prefix);
    r_hasher.update(message);
    let r_digest: [u8; 64] = r_hasher.finalize().into();
    let r = mod_l_64(&r_digest);

    let r_point_bytes = base.scalar_mul(&r).compress();

    let mut k_hasher = Sha512::new();
    k_hasher.update(r_point_bytes);
    k_hasher.update(pubkey);
    k_hasher.update(message);
    let k_digest: [u8; 64] = k_hasher.finalize().into();
    let k = mod_l_64(&k_digest);

    let s = add_mul_mod_l(&r, &k, &a);
    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(&r_point_bytes);
    sig[32..].copy_from_slice(&s);
    (pubkey, sig)
}

pub fn ed25519_verify(
    pubkey: &[u8; 32],
    message: &[u8],
    signature: &[u8; 64],
) -> Result<(), &'static str> {
    let a_point = ExtPoint::decompress(pubkey)?;
    let mut r_bytes = [0u8; 32];
    let mut s_bytes = [0u8; 32];
    r_bytes.copy_from_slice(&signature[..32]);
    s_bytes.copy_from_slice(&signature[32..]);

    if !is_canonical_scalar(&s_bytes) {
        return Err("Non-canonical signature scalar S >= L");
    }
    let r_point = ExtPoint::decompress(&r_bytes)?;

    let mut k_hasher = Sha512::new();
    k_hasher.update(r_bytes);
    k_hasher.update(pubkey);
    k_hasher.update(message);
    let k_digest: [u8; 64] = k_hasher.finalize().into();
    let k = mod_l_64(&k_digest);

    let two_d = fe_d();
    let two_d = two_d.add(two_d);

    let sb = ExtPoint::base_point().scalar_mul(&s_bytes);
    let ka = a_point.scalar_mul(&k);
    let rhs = r_point.add(ka, two_d);

    if sb.equals(rhs) {
        Ok(())
    } else {
        Err("Ed25519 signature verification failed")
    }
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
    }
}
