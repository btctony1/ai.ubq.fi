//! Pure provider protocols. This crate performs no network, credential, storage or quota I/O.
//! Callers own authoritative admission and must mark transport dispatch immediately before fetch.
pub mod anthropic;
pub mod chat;
mod claude_chat_stream;
pub mod extras;
pub mod finalize;
pub mod lithos;
pub mod paid_lookup;
pub mod policy;
pub mod replay;
pub mod request;
pub mod response;
mod source;
mod source_anthropic;
mod source_chat;
pub mod source_collector;
mod source_controls;
mod source_echo;
pub mod source_embeddings;
mod source_policy;
pub mod source_request;
mod source_response;
pub mod source_tools;
pub mod sse;
pub mod tools;
pub mod types;
pub mod usage;
pub mod writer;
