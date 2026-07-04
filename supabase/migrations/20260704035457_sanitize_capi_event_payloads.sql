update public.capi_events
set request_payload = request_payload - 'access_token'
where request_payload ? 'access_token';
