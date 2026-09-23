pub mod channel;
pub mod custody;
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub fn require(condition: bool, message: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(message.to_string().into())
    }
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
pub fn bytes(value: &str) -> Result<Vec<u8>> {
    require(
        value.len() <= 2 * 1024 * 1024
            && value.len() % 2 == 0
            && value
                .bytes()
                .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v)),
        "invalid hex",
    )?;
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).map_err(Into::into))
        .collect()
}
pub fn digest(bytes: &[u8]) -> String {
    hex(ring::digest::digest(&ring::digest::SHA256, bytes).as_ref())
}
pub fn frost_error(value: impl std::fmt::Debug) -> Box<dyn std::error::Error + Send + Sync> {
    format!("{value:?}").into()
}
