//! Source Cerebras error bodies forward only bounded message/code fields. The module below is
//! the unchanged former in-crate test module; it reaches these names through `super::*`.
use gateway_worker::inference_source::cerebras_error_body;
use serde_json::json;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cerebras_payment_required_body_forwards_only_source_detail_fields() {
        let input = br#"{"error":{"message":"Payment required","code":"payment_required","param":"secret","type":"vendor"},"secret":"never"}"#;
        let body = cerebras_error_body(402, input);
        let text = String::from_utf8(body.clone()).unwrap();
        assert_eq!(
            text,
            r#"{"error":{"message":"Payment required","type":"invalid_request_error","code":"payment_required"}}"#
        );
        assert!(!text.contains("vendor"));
        assert!(!text.contains("secret"));
        assert!(!text.contains("param"));
    }

    #[test]
    fn cerebras_payment_required_146_byte_source_shape() {
        let message = "x".repeat(65);
        let input = serde_json::to_vec(&json!({
            "error": {"message": message, "code": "payment_required"}
        }))
        .unwrap();
        let body = cerebras_error_body(402, &input);
        assert_eq!(body.len(), 146);
        assert_eq!(
            body,
            br#"{"error":{"message":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","type":"invalid_request_error","code":"payment_required"}}"#
        );
    }

    #[test]
    fn cerebras_status_types_and_bounds_follow_the_source() {
        let body = cerebras_error_body(429, br#"{"error":{"message":"slow down","code":"rate"}}"#);
        assert!(
            String::from_utf8(body)
                .unwrap()
                .contains("rate_limit_error")
        );
        let body = cerebras_error_body(503, br#"{"message":"down","code":"unavailable"}"#);
        assert!(String::from_utf8(body).unwrap().contains("server_error"));
        let oversized = serde_json::to_vec(&json!({
            "error": {"message": "m".repeat(2_000), "code": "c".repeat(400)}
        }))
        .unwrap();
        let body = String::from_utf8(cerebras_error_body(402, &oversized)).unwrap();
        assert!(!body.contains(&"m".repeat(1_001)));
        assert!(!body.contains(&"c".repeat(201)));
    }
}
