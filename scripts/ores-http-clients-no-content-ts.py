from pathlib import Path
import re

ROOT = Path('source')

p = ROOT / 'src/ts/src/index.ts'
text = p.read_text()
if 'requestEncodedOptional<' not in text:
    marker = '  async requestJson<TResponse, TRequest = unknown>(\n'
    block = '''  async requestEncodedOptional<TRequest, TResponse>(
    method: string,
    path: string,
    responseCodec: BinaryCodec<TResponse>,
    options: EncodedRequestOptions<TRequest> = {},
  ): Promise<TResponse | undefined> {
    const headers = new Headers(options.headers);
    if (!headers.has("accept")) headers.set("accept", responseCodec.mediaTypes.join(", "));
    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      if (!options.requestCodec) throw new Error("requestCodec is required when an encoded request body is provided");
      body = Uint8Array.from(options.requestCodec.encode(options.body)).buffer;
      if (!headers.has("content-type")) headers.set("content-type", options.requestCodec.contentType);
    }
    const response = await this.requestRaw(path, {method, headers, body});
    if (!response.ok) throw new HttpStatusError(response.status, response.url || this.endpoint(path));
    if (response.status === 204 || response.status === 205) return undefined;
    this.config.assertContentType(response, responseCodec.mediaTypes);
    return responseCodec.decode(await this.config.readBoundedBytes(response));
  }

  async requestOptionalJson<TResponse, TRequest = unknown>(
    method: string,
    path: string,
    options: {body?: TRequest; headers?: HeadersInit} = {},
  ): Promise<TResponse | undefined> {
    return this.requestEncodedOptional(method, path, jsonCodec<TResponse>(), {
      body: options.body,
      requestCodec: jsonCodec<TRequest>(),
      headers: options.headers,
    });
  }

'''
    if marker not in text: raise SystemExit('missing TS requestJson marker')
    text = text.replace(marker, block + marker, 1)
if 'requestOptionalMessagePack<' not in text:
    marker = '  async requestMessagePack<TResponse, TRequest = unknown>(\n'
    block = '''  async requestOptionalMessagePack<TResponse, TRequest = unknown>(
    method: string,
    path: string,
    options: {body?: TRequest; headers?: HeadersInit} = {},
  ): Promise<TResponse | undefined> {
    return this.requestEncodedOptional(method, path, messagePackCodec<TResponse>(), {
      body: options.body,
      requestCodec: messagePackCodec<TRequest>(),
      headers: options.headers,
    });
  }

'''
    if marker not in text: raise SystemExit('missing TS msgpack marker')
    text = text.replace(marker, block + marker, 1)
if 'requestOptionalProtobuf<' not in text:
    marker = '  async requestProtobuf<TRequest, TResponse>(\n'
    block = '''  async requestOptionalProtobuf<TRequest, TResponse>(
    method: string,
    path: string,
    requestCodec: BinaryCodec<TRequest>,
    responseCodec: BinaryCodec<TResponse>,
    options: {body?: TRequest; headers?: HeadersInit} = {},
  ): Promise<TResponse | undefined> {
    return this.requestEncodedOptional(method, path, responseCodec, {
      body: options.body,
      requestCodec,
      headers: options.headers,
    });
  }

'''
    if marker not in text: raise SystemExit('missing TS protobuf marker')
    text = text.replace(marker, block + marker, 1)
p.write_text(text)

p = ROOT / 'src/ts/src/generated.ts'
text = p.read_text()
if 'readonly allowsNoContent?: boolean;' not in text:
    text = re.sub(
        r'(?P<i>\s*)readonly operationKey: string;\n',
        lambda m: f'{m.group("i")}readonly operationKey: string;\n{m.group("i")}readonly allowsNoContent?: boolean;\n',
        text,
    )
p.write_text(text)

p = ROOT / 'src/ts/test/client.test.ts'
text = p.read_text()
if 'optional typed codecs treat 204 and 205 as no-content' not in text:
    text += '''

test("optional typed codecs treat 204 and 205 as no-content before content-type validation", async () => {
  type Proto = {id: number};
  const proto = protobufCodec<Proto>((v) => Uint8Array.of(v.id), (b) => ({id: b[0] ?? 0}));
  for (const status of [204, 205]) {
    const clients = new OresHttpClients({baseUrl: "https://example.test", fetch: async () => new Response(null, {status})});
    const raw = await clients.files.requestBytes("empty", {method: "GET"});
    assert.equal(raw.status, status);
    assert.equal(raw.data.byteLength, 0);
    assert.equal(await clients.rest.requestOptionalJson<{ok: true}>("GET", "empty"), undefined);
    assert.equal(await clients.rest.requestOptionalMessagePack<{ok: true}>("GET", "empty"), undefined);
    assert.equal(await clients.rest.requestOptionalProtobuf("GET", "empty", proto, proto), undefined);
  }
});
'''
p.write_text(text)

p = ROOT / 'src/ts/test/generated.test.ts'
text = p.read_text()
if 'generated unary metadata can advertise no-content' not in text:
    text += '''

test("generated unary metadata can advertise no-content without unsafe casts", async () => {
  const metadata: GeneratedOperationMetadata = {
    operationKey: "demo.users.delete_user",
    transport: "rpc",
    streamMode: "unary",
    allowsNoContent: true,
  };
  const value = await firstValueFrom(rxGeneratedUnary<number | undefined>(metadata, () => undefined));
  assert.equal(value, undefined);
});
'''
p.write_text(text)
