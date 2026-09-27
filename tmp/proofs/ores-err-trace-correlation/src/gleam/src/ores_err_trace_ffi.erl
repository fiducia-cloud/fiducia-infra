-module(ores_err_trace_ffi).
-export([normalize_message/1, normalize_dd_next_text/1, normalize_frame/1, normalize_ident/1, sha256_hex/1, join_fields/1, truncate_512/1]).

collapse_ws(Bin) ->
    Parts = re:split(string:trim(Bin), <<"\\s+">>, [{return, binary}, trim]),
    iolist_to_binary(lists:join(<<" ">>, Parts)).

normalize_message(Bin0) ->
    Bin1 = collapse_ws(Bin0),
    Bin2 = re:replace(Bin1, <<"\\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\\b">>, <<"<uuid>">>, [global, {return, binary}]),
    Bin3 = re:replace(Bin2, <<"\\b0x[0-9a-fA-F]+\\b">>, <<"<hex>">>, [global, {return, binary}]),
    re:replace(Bin3, <<"\\b[0-9]{4,}\\b">>, <<"<n>">>, [global, {return, binary}]).

normalize_dd_next_text(Bin0) ->
    Bin1 = re:replace(Bin0, <<"params:\\s*[\\s\\S]*$">>, <<"params:<redacted>">>, [caseless, {return, binary}]),
    Bin2 = re:replace(Bin1, <<"\\b(?:dd|ores)-trace-[A-Za-z0-9_-]+\\b">>, <<"<trace-id>">>, [global, {return, binary}]),
    Bin3 = re:replace(Bin2, <<"\\bddl-routine-[A-Za-z0-9_-]+\\b">>, <<"<routine-id>">>, [global, {return, binary}]),
    Bin4 = re:replace(Bin3, <<"\\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\\b">>, <<"<uuid>">>, [global, {return, binary}]),
    Bin5 = re:replace(Bin4, <<"\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b">>, <<"<email>">>, [global, caseless, {return, binary}]),
    Bin6 = re:replace(Bin5, <<"\\b[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z\\b">>, <<"<iso-timestamp>">>, [global, {return, binary}]),
    Bin7 = re:replace(Bin6, <<"\"(traceId|requestId|browserSessionId|hashcode|canonicalHashcode|incomingHashcode)\"\\s*:\\s*\"[^\"]*\"">>, <<"\"\\1\":\"<redacted>\"">>, [global, {return, binary}]),
    Bin8 = re:replace(Bin7, <<"\\b(reqId|requestId|browserSessionId):[A-Za-z0-9_-]+\\b">>, <<"\\1:<id>">>, [global, caseless, {return, binary}]),
    Bin9 = re:replace(Bin8, <<"\\b[0-9]{10,}\\b">>, <<"<long-number>">>, [global, {return, binary}]),
    Collapsed = collapse_ws(Bin9),
    Chars = unicode:characters_to_list(Collapsed),
    unicode:characters_to_binary(lists:sublist(Chars, 2000)).

normalize_frame(Bin) ->
    re:replace(normalize_message(Bin), <<":[0-9]+(?::[0-9]+)?\\)?$">>, <<>>, [{return, binary}]).

normalize_ident(Bin) ->
    string:lowercase(collapse_ws(Bin)).

sha256_hex(Bin) ->
    Digest = crypto:hash(sha256, Bin),
    iolist_to_binary(io_lib:format("~64.16.0b", [binary:decode_unsigned(Digest)])).

join_fields(Fields) ->
    Safe = [binary:replace(F, <<31>>, <<"<sep>">>, [global]) || F <- Fields],
    iolist_to_binary(lists:join(<<31>>, Safe)).

truncate_512(Bin) ->
    Chars = unicode:characters_to_list(Bin),
    unicode:characters_to_binary(lists:sublist(Chars, 512)).
