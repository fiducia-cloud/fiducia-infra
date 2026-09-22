from pathlib import Path

path = Path("crates/ores-stack-cli/src/ppr_supervisor_process.rs")
text = path.read_text()


def once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    text = text.replace(old, new, 1)


once(
    "use ores_stack_process_tree::ProcessTreeChild;\n",
    "use ores_stack_process_tree::ProcessTreeChild;\n"
    "use ores_stack_ppr_http::{\n"
    "    ResponseHead as FramedResponseHead, read_response_head as read_framed_response_head,\n"
    "    relay_body as relay_framed_body,\n"
    "};\n"
    "use crate::ppr_middleware_wrapper;\n",
    "shared PPR authority imports",
)
once(
    "const MAX_RESPONSE_HEAD_BYTES: usize = 64 * 1024;\n",
    "",
    "remove duplicate response-head bound",
)
once(
    "#[derive(Debug)]\n"
    "struct ResponseHead {\n"
    "    status: u16,\n"
    "    version: String,\n"
    "    headers: Vec<(String, String)>,\n"
    "    prefetched_body: Vec<u8>,\n"
    "    content_length: Option<u64>,\n"
    "}\n\n",
    "",
    "remove duplicate ResponseHead",
)
once(
    "#[derive(Debug)]\nstruct RelayOutcome {\n    status: u16,\n    content_length: Option<u64>,\n}\n",
    "#[derive(Debug)]\nstruct RelayOutcome {\n    status: u16,\n    response_bytes: u64,\n}\n",
    "decoded relay accounting",
)

once(
    "            MiddlewareOutput::Admitted { headers } => {\n"
    "                session.projected_headers = headers;\n"
    "                Ok(Ok(session))\n"
    "            }",
    "            MiddlewareOutput::Admitted { headers } => {\n"
    "                validate_middleware_response_headers(&headers)?;\n"
    "                session.projected_headers = headers;\n"
    "                Ok(Ok(session))\n"
    "            }",
    "admitted middleware header validation",
)
once(
    "            MiddlewareOutput::Rejected {\n"
    "                status,\n"
    "                code,\n"
    "                message,\n"
    "                headers,\n"
    "            } => {\n"
    "                let _ = session.wait_until(operation_deadline);\n"
    "                Ok(Err(MiddlewareRejection {\n"
    "                    status,\n"
    "                    code,\n"
    "                    message,\n"
    "                    headers,\n"
    "                }))\n"
    "            }",
    "            MiddlewareOutput::Rejected {\n"
    "                status,\n"
    "                code,\n"
    "                message,\n"
    "                headers,\n"
    "            } => {\n"
    "                validate_middleware_response_headers(&headers)?;\n"
    "                let _ = session.wait_until(operation_deadline);\n"
    "                Ok(Err(MiddlewareRejection {\n"
    "                    status,\n"
    "                    code,\n"
    "                    message,\n"
    "                    headers,\n"
    "                }))\n"
    "            }",
    "rejected middleware header validation",
)

once(
    "    let (relay_tx, relay_rx) = mpsc::sync_channel(1);\n"
    "    let relay_headers = projected_headers.clone();\n"
    "    thread::Builder::new()\n",
    "    let (relay_tx, relay_rx) = mpsc::sync_channel(1);\n"
    "    let relay_headers = projected_headers.clone();\n"
    "    let relay_method = request.method.clone();\n"
    "    thread::Builder::new()\n",
    "capture request method for response framing",
)
once(
    "            let result = relay_response(child_stdout, relay_client, &relay_headers);",
    "            let result = relay_response(\n"
    "                child_stdout,\n"
    "                relay_client,\n"
    "                &relay_headers,\n"
    "                &relay_method,\n"
    "            );",
    "relay method propagation",
)
once(
    "    let finish_length = status.success().then_some(outcome.content_length).flatten();\n",
    "    let finish_length = status.success().then_some(outcome.response_bytes);\n",
    "terminal decoded-byte accounting",
)

start = text.index("fn middleware_frame_reader(")
end = text.index("\nfn prepare_middleware_runner(", start)
text = text[:start] + r'''fn middleware_frame_reader(
    stdout: ChildStdout,
    sender: mpsc::SyncSender<Result<MiddlewareOutput, String>>,
) {
    let mut reader = BufReader::new(stdout);
    loop {
        let mut line = String::new();
        let read = (&mut reader)
            .take((MAX_MIDDLEWARE_FRAME_BYTES + 2) as u64)
            .read_line(&mut line);
        match read {
            Ok(0) => {
                let _ = sender.send(Err(
                    "PPR middleware control stream ended unexpectedly".to_owned(),
                ));
                return;
            }
            Ok(_) if !line.ends_with('\n') => {
                let _ = sender.send(Err(
                    "PPR middleware control frame must end with newline".to_owned(),
                ));
                return;
            }
            Ok(_) if line.len() > MAX_MIDDLEWARE_FRAME_BYTES + 1 => {
                let _ = sender.send(Err(format!(
                    "PPR middleware control frame exceeds {MAX_MIDDLEWARE_FRAME_BYTES} bytes"
                )));
                return;
            }
            Ok(_) => {
                let frame =
                    serde_json::from_str::<MiddlewareOutput>(line.trim_end_matches(['\r', '\n']))
                        .map_err(|error| format!("invalid PPR middleware control JSON: {error}"));
                if sender.send(frame).is_err() {
                    return;
                }
            }
            Err(error) => {
                let _ = sender.send(Err(format!(
                    "could not read PPR middleware control frame: {error}"
                )));
                return;
            }
        }
    }
}
''' + text[end:]

once(
    "    let tmp = tmp_root.join(\"ores-stack-ppr-middleware\");\n"
    "    ensure_real_dir(root, &tmp)?;\n"
    "    let lock_path = tmp.join(\".ores-stack-ppr-generate.lock\");\n",
    "    let tmp = tmp_root.join(\"ores-stack-ppr-middleware\");\n"
    "    ensure_real_dir(root, &tmp)?;\n"
    "    let app = ppr_middleware_wrapper::discover_app_crate(root)?;\n"
    "    let lock_path = tmp.join(\".ores-stack-ppr-generate.lock\");\n",
    "discover authored middleware app crate",
)
once(
    "            render_middleware_main().as_bytes(),\n"
    "            GENERATED_MW_MAIN_MARKER,",
    "            ppr_middleware_wrapper::render_main(MAX_MIDDLEWARE_FRAME_BYTES).as_bytes(),\n"
    "            GENERATED_MW_MAIN_MARKER,",
    "reuse app-aware middleware main renderer",
)
once(
    "            render_middleware_manifest().as_bytes(),\n"
    "            GENERATED_MW_MANIFEST_MARKER,",
    "            ppr_middleware_wrapper::render_manifest(\n"
    "                &app.package_name,\n"
    "                ORES_MIDDLEWARE_GIT,\n"
    "                ORES_MIDDLEWARE_REV,\n"
    "            )\n"
    "            .as_bytes(),\n"
    "            GENERATED_MW_MANIFEST_MARKER,",
    "reuse app-aware middleware manifest renderer",
)
start = text.index("fn render_middleware_manifest()")
end = text.index("\nfn ensure_real_dir(", start)
text = text[:start] + text[end:]

start = text.index("fn relay_response(")
end = text.index("\nfn read_normalized_request(", start)
text = text[:start] + r'''struct DisconnectTrackingWriter<'a> {
    client: &'a mut TcpStream,
    write_failed: bool,
}

impl Write for DisconnectTrackingWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self.client.write(buf) {
            Ok(count) => Ok(count),
            Err(error) => {
                self.write_failed = true;
                Err(error)
            }
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.client.flush() {
            Ok(()) => Ok(()),
            Err(error) => {
                self.write_failed = true;
                Err(error)
            }
        }
    }
}

fn relay_response(
    mut child_stdout: ChildStdout,
    mut client: TcpStream,
    middleware_headers: &BTreeMap<String, String>,
    request_method: &str,
) -> Result<RelayOutcome, RelayFailure> {
    let response = match read_framed_response_head(&mut child_stdout, request_method) {
        Ok(response) => response,
        Err(message) => {
            write_proxy_error_with_headers(
                &mut client,
                "502 Bad Gateway",
                "dev request child returned an invalid response\n",
                middleware_headers,
            );
            return Err(RelayFailure {
                finish_status: 502,
                client_disconnected: false,
                message,
            });
        }
    };
    if let Err(message) = write_response_head(&mut client, &response, middleware_headers) {
        return Err(RelayFailure {
            finish_status: 502,
            client_disconnected: false,
            message,
        });
    }

    let mut writer = DisconnectTrackingWriter {
        client: &mut client,
        write_failed: false,
    };
    let response_bytes = match relay_framed_body(
        &mut child_stdout,
        &mut writer,
        response.framing,
        &response.prefetched_body,
    ) {
        Ok(bytes) => bytes,
        Err(message) => {
            return Err(RelayFailure {
                finish_status: if writer.write_failed { 499 } else { 502 },
                client_disconnected: writer.write_failed,
                message,
            });
        }
    };
    Ok(RelayOutcome {
        status: response.status,
        response_bytes,
    })
}
''' + text[end:]

start = text.index("fn read_response_head(")
end = text.index("\nfn write_response_head(", start)
text = text[:start] + text[end:]

once(
    "    response: &ResponseHead,\n",
    "    response: &FramedResponseHead,\n",
    "shared response head type",
)
once(
    ") -> Result<(), String> {\n    let mut headers = response.headers.clone();\n",
    ") -> Result<(), String> {\n"
    "    validate_middleware_response_headers(middleware_headers)?;\n"
    "    let mut headers = response.headers.clone();\n",
    "validate middleware headers before response merge",
)
once(
    "    headers.retain(|(name, _)| !name.eq_ignore_ascii_case(\"connection\"));\n",
    "    headers.retain(|(name, _)| {\n"
    "        !matches!(\n"
    "            name.to_ascii_lowercase().as_str(),\n"
    "            \"connection\" | \"keep-alive\" | \"proxy-connection\" | \"upgrade\" | \"te\" | \"trailer\"\n"
    "        )\n"
    "    });\n",
    "strip child hop-by-hop response headers",
)

helper = r'''
fn validate_middleware_response_headers(headers: &BTreeMap<String, String>) -> Result<(), String> {
    for (name, value) in headers {
        let normalized = name.to_ascii_lowercase();
        if name.is_empty() || !name.bytes().all(http_token_byte) {
            return Err(format!("invalid middleware response header name {name:?}"));
        }
        if value
            .bytes()
            .any(|byte| byte == 0 || matches!(byte, b'\r' | b'\n'))
        {
            return Err(format!("invalid middleware response header value for {name:?}"));
        }
        if matches!(
            normalized.as_str(),
            "content-length"
                | "transfer-encoding"
                | "content-encoding"
                | "connection"
                | "keep-alive"
                | "proxy-connection"
                | "upgrade"
                | "te"
                | "trailer"
        ) {
            return Err(format!(
                "middleware response projection may not control HTTP body framing/header {name:?}"
            ));
        }
    }
    Ok(())
}

'''
marker = "fn write_middleware_rejection(client: &mut TcpStream, rejection: &MiddlewareRejection) {"
if text.count(marker) != 1:
    raise SystemExit("response-header validation insertion point drifted")
text = text.replace(marker, helper + marker, 1)

once(
    "        if !name.eq_ignore_ascii_case(\"content-length\")\n"
    "            && !name.eq_ignore_ascii_case(\"connection\")\n"
    "            && name.bytes().all(http_token_byte)\n",
    "        if !matches!(\n"
    "                name.to_ascii_lowercase().as_str(),\n"
    "                \"content-length\"\n"
    "                    | \"transfer-encoding\"\n"
    "                    | \"content-encoding\"\n"
    "                    | \"connection\"\n"
    "                    | \"keep-alive\"\n"
    "                    | \"proxy-connection\"\n"
    "                    | \"upgrade\"\n"
    "                    | \"te\"\n"
    "                    | \"trailer\"\n"
    "            )\n"
    "            && name.bytes().all(http_token_byte)\n",
    "safe proxy error response headers",
)

once(
    "        assert!(source.contains(\"write_all(&buffer[..count])\"));\n"
    "        assert!(source.contains(\"and_then(|()| client.flush())\"));",
    "        assert!(source.contains(\"relay_framed_body\"));\n"
    "        assert!(source.contains(\"response_bytes\"));",
    "supervisor framing authority regression",
)
once(
    "        assert!(read_response_head(&mut &duplicate[..]).is_err());",
    "        assert!(read_framed_response_head(&mut &duplicate[..], \"GET\").is_err());",
    "duplicate content-length regression",
)
once(
    "        assert!(read_response_head(&mut &mixed[..]).is_err());",
    "        assert!(read_framed_response_head(&mut &mixed[..], \"GET\").is_err());",
    "mixed framing regression",
)
once(
    "        let manifest = render_middleware_manifest();\n"
    "        assert!(manifest.contains(ORES_MIDDLEWARE_REV));\n"
    "        assert!(manifest.contains(\"ores-stack-ppr-middleware\"));\n"
    "        let source = render_middleware_main();",
    "        let manifest = ppr_middleware_wrapper::render_manifest(\n"
    "            \"demo\",\n"
    "            ORES_MIDDLEWARE_GIT,\n"
    "            ORES_MIDDLEWARE_REV,\n"
    "        );\n"
    "        assert!(manifest.contains(ORES_MIDDLEWARE_REV));\n"
    "        assert!(manifest.contains(\"ores-stack-ppr-middleware\"));\n"
    "        assert!(manifest.contains(\"ores-app\"));\n"
    "        let source = ppr_middleware_wrapper::render_main(MAX_MIDDLEWARE_FRAME_BYTES);",
    "app-aware middleware generator regression",
)
once(
    "        assert!(source.contains(\"response_headers(&stack, &active)\"));\n",
    "        assert!(source.contains(\"response_headers(&stack, &active)\"));\n"
    "        assert!(source.contains(\"ores_app::middleware::configure\"));\n"
    "        assert!(source.contains(\"input.take\"));\n",
    "middleware configure/bounded-read regression",
)

test_insert = r'''
    #[test]
    fn middleware_response_projection_cannot_rewrite_body_framing() {
        for name in [
            "content-length",
            "transfer-encoding",
            "content-encoding",
            "connection",
            "keep-alive",
            "proxy-connection",
            "upgrade",
            "te",
            "trailer",
        ] {
            let mut headers = BTreeMap::new();
            headers.insert(name.to_owned(), "x".to_owned());
            assert!(validate_middleware_response_headers(&headers).is_err(), "{name}");
        }
        let mut allowed = BTreeMap::new();
        allowed.insert("cache-control".to_owned(), "no-store".to_owned());
        allowed.insert(
            "content-security-policy".to_owned(),
            "default-src 'self'".to_owned(),
        );
        assert!(validate_middleware_response_headers(&allowed).is_ok());
    }

'''
test_marker = "    #[test]\n    fn middleware_stack_path_cannot_escape_repository() {"
if text.count(test_marker) != 1:
    raise SystemExit("test insertion point drifted")
text = text.replace(test_marker, test_insert + test_marker, 1)

for forbidden in [
    "fn render_middleware_main()",
    "fn render_middleware_manifest()",
    "fn read_response_head(reader:",
    "struct ResponseHead {",
]:
    if forbidden in text:
        raise SystemExit(f"duplicate authority still present: {forbidden}")

path.write_text(text)
