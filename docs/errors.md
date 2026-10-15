# MiuJS error codes

Every error MiuJS returns or throws has a stable code. A code is never reworded once released;
messages and fixes may improve.

```json
{ "error": { "code": "MIU_E_NOT_FOUND", "message": "user \"7\" not found",
  "docs": "https://github.com/khangkhangg/miujs/blob/miujs-monorepo/docs/errors.md#miu_e_not_found" } }
```

The `docs` link in every error body points at the code's section below (the code in lowercase).
`MIU_E_*` codes are errors; `MIU_W_*` codes are warnings printed by `miu check`.
Placeholders like `{id}` stand for values filled in at runtime.

This file is generated from the sources by `bun scripts/error-catalog.ts`. Don't edit it by hand:
change the message or fix where the error is thrown, then regenerate. CI fails when a code in
`packages/*/src` has no section here.

## Index

| Package | Codes |
| --- | --- |
| `miujs` | [MIU_E_APP_NOT_READY](#miu_e_app_not_ready), [MIU_E_APP_STARTED](#miu_e_app_started), [MIU_E_BAD_JSON](#miu_e_bad_json), [MIU_E_BAD_REQUEST](#miu_e_bad_request), [MIU_E_BODY_TOO_LARGE](#miu_e_body_too_large), [MIU_E_CLOUDFLARE_ASSETS_CONFLICT](#miu_e_cloudflare_assets_conflict), [MIU_E_CONFLICT](#miu_e_conflict), [MIU_E_COOKIE_VALUE_INVALID](#miu_e_cookie_value_invalid), [MIU_E_FORBIDDEN](#miu_e_forbidden), [MIU_E_INTERNAL](#miu_e_internal), [MIU_E_LISTEN_UNSUPPORTED](#miu_e_listen_unsupported), [MIU_E_MCP_TOOL_DUPLICATE](#miu_e_mcp_tool_duplicate), [MIU_E_METHOD_NOT_ALLOWED](#miu_e_method_not_allowed), [MIU_E_NOT_FOUND](#miu_e_not_found), [MIU_E_PARAM_MISSING](#miu_e_param_missing), [MIU_E_PARAM_SHADOWED](#miu_e_param_shadowed), [MIU_E_PARAM_UNKNOWN](#miu_e_param_unknown), [MIU_E_PERMISSION_UNCHECKED](#miu_e_permission_unchecked), [MIU_E_RATE_LIMITED](#miu_e_rate_limited), [MIU_E_RESPONSE_INVALID](#miu_e_response_invalid), [MIU_E_ROUTE_CONFLICT](#miu_e_route_conflict), [MIU_E_ROUTE_DUPLICATE](#miu_e_route_duplicate), [MIU_E_ROUTE_INVALID](#miu_e_route_invalid), [MIU_E_ROUTE_NAME_DUPLICATE](#miu_e_route_name_duplicate), [MIU_E_ROUTE_NOT_FOUND](#miu_e_route_not_found), [MIU_E_SERVICE_DUPLICATE](#miu_e_service_duplicate), [MIU_E_SERVICE_MISSING](#miu_e_service_missing), [MIU_E_UNAUTHORIZED](#miu_e_unauthorized), [MIU_E_VALIDATION](#miu_e_validation), [MIU_E_WS_EXPECTED](#miu_e_ws_expected), [MIU_E_WS_UNSUPPORTED](#miu_e_ws_unsupported) |
| `@miujs/cli` | [MIU_E_CLI_ADD_USAGE](#miu_e_cli_add_usage), [MIU_E_CLI_BUILD_FAILED](#miu_e_cli_build_failed), [MIU_E_CLI_DB_NOT_FOUND](#miu_e_cli_db_not_found), [MIU_E_CLI_DB_SOURCE](#miu_e_cli_db_source), [MIU_E_CLI_DB_USAGE](#miu_e_cli_db_usage), [MIU_E_CLI_DENO_JSON](#miu_e_cli_deno_json), [MIU_E_CLI_DEPLOY_TARGET](#miu_e_cli_deploy_target), [MIU_E_CLI_DRIZZLE_MISSING](#miu_e_cli_drizzle_missing), [MIU_E_CLI_EXISTS](#miu_e_cli_exists), [MIU_E_CLI_FLAG_VALUE](#miu_e_cli_flag_value), [MIU_E_CLI_LOADTEST_USAGE](#miu_e_cli_loadtest_usage), [MIU_E_CLI_LOGS_FILE](#miu_e_cli_logs_file), [MIU_E_CLI_LOGS_SOURCE](#miu_e_cli_logs_source), [MIU_E_CLI_NEW_USAGE](#miu_e_cli_new_usage), [MIU_E_CLI_NO_APP](#miu_e_cli_no_app), [MIU_E_CLI_NO_DEFAULT_EXPORT](#miu_e_cli_no_default_export), [MIU_E_CLI_SCHEMA_EMPTY](#miu_e_cli_schema_empty), [MIU_E_CLI_SCHEMA_NOT_FOUND](#miu_e_cli_schema_not_found), [MIU_E_CLI_TEMPLATE](#miu_e_cli_template), [MIU_E_CLI_UNKNOWN_COMMAND](#miu_e_cli_unknown_command), [MIU_E_CLI_UNKNOWN_FLAG](#miu_e_cli_unknown_flag), [MIU_E_CLI_WRANGLER](#miu_e_cli_wrangler), [MIU_E_NOT_IMPLEMENTED](#miu_e_not_implemented), [MIU_W_DO_NOT_EXPORTED](#miu_w_do_not_exported), [MIU_W_SECRET_IN_CODE](#miu_w_secret_in_code), [MIU_W_TYPECHECK](#miu_w_typecheck), [MIU_W_UNAUTHENTICATED_MUTATION](#miu_w_unauthenticated_mutation), [MIU_W_WORKERS_BUNDLE](#miu_w_workers_bundle), [MIU_W_WORKERS_NODE_IMPORT](#miu_w_workers_node_import), [MIU_W_WORKFLOW_NOT_EXPORTED](#miu_w_workflow_not_exported) |
| `@miujs/auth` | [MIU_E_AUTH_APP_URL_INVALID](#miu_e_auth_app_url_invalid), [MIU_E_AUTH_APP_URL_MISSING](#miu_e_auth_app_url_missing), [MIU_E_AUTH_EMAIL_TAKEN](#miu_e_auth_email_taken), [MIU_E_AUTH_EMAIL_UNVERIFIED](#miu_e_auth_email_unverified), [MIU_E_AUTH_HASH_UNSUPPORTED](#miu_e_auth_hash_unsupported), [MIU_E_AUTH_INVALID](#miu_e_auth_invalid), [MIU_E_AUTH_MAILER_MISSING](#miu_e_auth_mailer_missing), [MIU_E_AUTH_OAUTH_ACCOUNT_EXISTS](#miu_e_auth_oauth_account_exists), [MIU_E_AUTH_OAUTH_ALREADY_LINKED](#miu_e_auth_oauth_already_linked), [MIU_E_AUTH_OAUTH_CLIENT_SECRET_MISSING](#miu_e_auth_oauth_client_secret_missing), [MIU_E_AUTH_OAUTH_CONFIG](#miu_e_auth_oauth_config), [MIU_E_AUTH_OAUTH_CONFLICT](#miu_e_auth_oauth_conflict), [MIU_E_AUTH_OAUTH_DENIED](#miu_e_auth_oauth_denied), [MIU_E_AUTH_OAUTH_DISCOVERY](#miu_e_auth_oauth_discovery), [MIU_E_AUTH_OAUTH_EMAIL_UNVERIFIED](#miu_e_auth_oauth_email_unverified), [MIU_E_AUTH_OAUTH_ID_TOKEN](#miu_e_auth_oauth_id_token), [MIU_E_AUTH_OAUTH_LAST_METHOD](#miu_e_auth_oauth_last_method), [MIU_E_AUTH_OAUTH_PROFILE](#miu_e_auth_oauth_profile), [MIU_E_AUTH_OAUTH_PROVIDER_UNKNOWN](#miu_e_auth_oauth_provider_unknown), [MIU_E_AUTH_OAUTH_RETURN_TO](#miu_e_auth_oauth_return_to), [MIU_E_AUTH_OAUTH_SESSION_REQUIRED](#miu_e_auth_oauth_session_required), [MIU_E_AUTH_OAUTH_STATE](#miu_e_auth_oauth_state), [MIU_E_AUTH_OAUTH_STATE_SECRET_MISSING](#miu_e_auth_oauth_state_secret_missing), [MIU_E_AUTH_OAUTH_TOKEN](#miu_e_auth_oauth_token), [MIU_E_AUTH_PASSKEY_ALGORITHM](#miu_e_auth_passkey_algorithm), [MIU_E_AUTH_PASSKEY_ATTESTATION](#miu_e_auth_passkey_attestation), [MIU_E_AUTH_PASSKEY_CHALLENGE](#miu_e_auth_passkey_challenge), [MIU_E_AUTH_PASSKEY_CLONED](#miu_e_auth_passkey_cloned), [MIU_E_AUTH_PASSKEY_CONFIG](#miu_e_auth_passkey_config), [MIU_E_AUTH_PASSKEY_EXISTS](#miu_e_auth_passkey_exists), [MIU_E_AUTH_PASSKEY_FLAGS](#miu_e_auth_passkey_flags), [MIU_E_AUTH_PASSKEY_INVALID](#miu_e_auth_passkey_invalid), [MIU_E_AUTH_PASSKEY_ORIGIN](#miu_e_auth_passkey_origin), [MIU_E_AUTH_PASSKEY_RP_ID](#miu_e_auth_passkey_rp_id), [MIU_E_AUTH_PASSKEY_SESSION_REQUIRED](#miu_e_auth_passkey_session_required), [MIU_E_AUTH_PASSWORD_INCORRECT](#miu_e_auth_password_incorrect), [MIU_E_AUTH_PASSWORD_WEAK](#miu_e_auth_password_weak), [MIU_E_AUTH_RATELIMIT_BINDING](#miu_e_auth_ratelimit_binding), [MIU_E_AUTH_RESET_INVALID](#miu_e_auth_reset_invalid), [MIU_E_AUTH_SESSION_REQUIRED](#miu_e_auth_session_required), [MIU_E_AUTH_STORE_UNSUPPORTED](#miu_e_auth_store_unsupported), [MIU_E_AUTH_TOKEN_INVALID](#miu_e_auth_token_invalid), [MIU_E_AUTH_TURNSTILE_FAILED](#miu_e_auth_turnstile_failed), [MIU_E_AUTH_TURNSTILE_SECRET_MISSING](#miu_e_auth_turnstile_secret_missing), [MIU_E_AUTH_VERIFY_INVALID](#miu_e_auth_verify_invalid) |
| `@miujs/session` | [MIU_E_CSRF](#miu_e_csrf), [MIU_E_SESSION_KV_MISSING](#miu_e_session_kv_missing), [MIU_E_SESSION_REDIS](#miu_e_session_redis), [MIU_E_SESSION_REDIS_CLIENT](#miu_e_session_redis_client), [MIU_E_SESSION_SECRET_MISSING](#miu_e_session_secret_missing), [MIU_E_SESSION_SECRET_WEAK](#miu_e_session_secret_weak), [MIU_E_SESSION_TABLE_INVALID](#miu_e_session_table_invalid), [MIU_E_SESSION_TOO_LARGE](#miu_e_session_too_large) |
| `@miujs/db` | [MIU_E_DB_BIND_UNDEFINED](#miu_e_db_bind_undefined), [MIU_E_DB_BINDING_MISSING](#miu_e_db_binding_missing), [MIU_E_DB_CLOSED](#miu_e_db_closed), [MIU_E_DB_DRIZZLE_MISSING](#miu_e_db_drizzle_missing), [MIU_E_DB_MIGRATION_DUPLICATE](#miu_e_db_migration_duplicate), [MIU_E_DB_MIGRATION_FAILED](#miu_e_db_migration_failed), [MIU_E_DB_MIGRATION_INVALID](#miu_e_db_migration_invalid), [MIU_E_DB_MIGRATION_NAME](#miu_e_db_migration_name), [MIU_E_DB_MIGRATIONS_DIR](#miu_e_db_migrations_dir), [MIU_E_DB_MISSING](#miu_e_db_missing), [MIU_E_DB_SCHEMA](#miu_e_db_schema), [MIU_E_DB_UNSUPPORTED](#miu_e_db_unsupported) |
| `@miujs/cache` | [MIU_E_CACHE_BINDING](#miu_e_cache_binding), [MIU_E_CACHE_CONFIG](#miu_e_cache_config), [MIU_E_CACHE_KEY](#miu_e_cache_key), [MIU_E_CACHE_REDIS](#miu_e_cache_redis), [MIU_E_CACHE_REDIS_RUNTIME](#miu_e_cache_redis_runtime), [MIU_E_CACHE_TTL](#miu_e_cache_ttl), [MIU_E_CACHE_VALUE](#miu_e_cache_value) |
| `@miujs/queue` | [MIU_E_QUEUE_BINDING](#miu_e_queue_binding), [MIU_E_QUEUE_CONFIG](#miu_e_queue_config), [MIU_E_QUEUE_CRON](#miu_e_queue_cron), [MIU_E_QUEUE_DELAY](#miu_e_queue_delay), [MIU_E_QUEUE_JOB_DUPLICATE](#miu_e_queue_job_duplicate), [MIU_E_QUEUE_REDIS](#miu_e_queue_redis), [MIU_E_QUEUE_RUNTIME](#miu_e_queue_runtime), [MIU_E_QUEUE_SQLITE](#miu_e_queue_sqlite), [MIU_E_QUEUE_TIMEOUT](#miu_e_queue_timeout), [MIU_E_QUEUE_UNKNOWN_JOB](#miu_e_queue_unknown_job) |
| `@miujs/ratelimit` | [MIU_E_RATELIMIT_BINDING](#miu_e_ratelimit_binding), [MIU_E_RATELIMIT_CONFIG](#miu_e_ratelimit_config), [MIU_E_RATELIMIT_ORDER](#miu_e_ratelimit_order), [MIU_E_RATELIMIT_STORE](#miu_e_ratelimit_store), [MIU_E_RATELIMIT_UNSUPPORTED](#miu_e_ratelimit_unsupported) |
| `@miujs/realtime` | [MIU_E_ROOM_ALREADY_JOINED](#miu_e_room_already_joined), [MIU_E_ROOM_BAD_FRAME](#miu_e_room_bad_frame), [MIU_E_ROOM_CLIENT_NOT_FOUND](#miu_e_room_client_not_found), [MIU_E_ROOM_CLOSED](#miu_e_room_closed), [MIU_E_ROOM_CODE_RATE_LIMITED](#miu_e_room_code_rate_limited), [MIU_E_ROOM_CODE_UNKNOWN](#miu_e_room_code_unknown), [MIU_E_ROOM_CODES_EXHAUSTED](#miu_e_room_codes_exhausted), [MIU_E_ROOM_CREATE_FAILED](#miu_e_room_create_failed), [MIU_E_ROOM_ENCODING_UNSUPPORTED](#miu_e_room_encoding_unsupported), [MIU_E_ROOM_FULL](#miu_e_room_full), [MIU_E_ROOM_HANDLER_FAILED](#miu_e_room_handler_failed), [MIU_E_ROOM_HANDLER_UNKNOWN](#miu_e_room_handler_unknown), [MIU_E_ROOM_HOST_KEY](#miu_e_room_host_key), [MIU_E_ROOM_ID_INVALID](#miu_e_room_id_invalid), [MIU_E_ROOM_JOIN_INVALID](#miu_e_room_join_invalid), [MIU_E_ROOM_JOIN_REJECTED](#miu_e_room_join_rejected), [MIU_E_ROOM_KICKED](#miu_e_room_kicked), [MIU_E_ROOM_MESSAGE_INVALID](#miu_e_room_message_invalid), [MIU_E_ROOM_MESSAGE_TOO_LARGE](#miu_e_room_message_too_large), [MIU_E_ROOM_NOT_FOUND](#miu_e_room_not_found), [MIU_E_ROOM_NOT_JOINED](#miu_e_room_not_joined), [MIU_E_ROOM_RATE_LIMITED](#miu_e_room_rate_limited), [MIU_E_ROOM_REACT_MISSING](#miu_e_room_react_missing), [MIU_E_ROOM_RESUME_EXPIRED](#miu_e_room_resume_expired), [MIU_E_ROOM_SHARD_SIZE](#miu_e_room_shard_size), [MIU_E_ROOM_STATE_INVALID](#miu_e_room_state_invalid), [MIU_E_ROOM_TIMER_NOT_DURABLE](#miu_e_room_timer_not_durable), [MIU_E_ROOM_TIMER_UNKNOWN](#miu_e_room_timer_unknown), [MIU_E_ROOM_TYPE_INVALID](#miu_e_room_type_invalid), [MIU_E_ROOM_TYPE_UNKNOWN](#miu_e_room_type_unknown), [MIU_E_ROOM_UNKNOWN_MESSAGE](#miu_e_room_unknown_message) |
| `@miujs/files` | [MIU_E_FILES_BAD_FORM](#miu_e_files_bad_form), [MIU_E_FILES_BAD_REQUEST](#miu_e_files_bad_request), [MIU_E_FILES_BINDING](#miu_e_files_binding), [MIU_E_FILES_BODY_USED](#miu_e_files_body_used), [MIU_E_FILES_CONFIG](#miu_e_files_config), [MIU_E_FILES_KEY_CONFLICT](#miu_e_files_key_conflict), [MIU_E_FILES_KEY_INVALID](#miu_e_files_key_invalid), [MIU_E_FILES_METADATA_INVALID](#miu_e_files_metadata_invalid), [MIU_E_FILES_NO_FILE](#miu_e_files_no_file), [MIU_E_FILES_NOT_FOUND](#miu_e_files_not_found), [MIU_E_FILES_PART_INVALID](#miu_e_files_part_invalid), [MIU_E_FILES_RUNTIME](#miu_e_files_runtime), [MIU_E_FILES_S3](#miu_e_files_s3), [MIU_E_FILES_S3_CONFIG](#miu_e_files_s3_config), [MIU_E_FILES_SECRET_MISSING](#miu_e_files_secret_missing), [MIU_E_FILES_SECRET_WEAK](#miu_e_files_secret_weak), [MIU_E_FILES_STORE_MISSING](#miu_e_files_store_missing), [MIU_E_FILES_TOKEN_EXPIRED](#miu_e_files_token_expired), [MIU_E_FILES_TOKEN_INVALID](#miu_e_files_token_invalid), [MIU_E_FILES_TOO_LARGE](#miu_e_files_too_large), [MIU_E_FILES_TOO_MANY_FILES](#miu_e_files_too_many_files), [MIU_E_FILES_TYPE_NOT_ALLOWED](#miu_e_files_type_not_allowed), [MIU_E_FILES_UPLOAD_NOT_FOUND](#miu_e_files_upload_not_found) |
| `@miujs/web` | [MIU_E_WEB_BAD_PATH](#miu_e_web_bad_path), [MIU_E_WEB_CONFIG](#miu_e_web_config), [MIU_E_WEB_HTML_ASYNC](#miu_e_web_html_async), [MIU_E_WEB_HTML_FUNCTION](#miu_e_web_html_function), [MIU_E_WEB_HTML_RAW](#miu_e_web_html_raw), [MIU_E_WEB_HX_URL](#miu_e_web_hx_url), [MIU_E_WEB_JSX_ATTR](#miu_e_web_jsx_attr), [MIU_E_WEB_JSX_EVENT_HANDLER](#miu_e_web_jsx_event_handler), [MIU_E_WEB_JSX_INNER_HTML](#miu_e_web_jsx_inner_html), [MIU_E_WEB_JSX_TAG](#miu_e_web_jsx_tag), [MIU_E_WEB_JSX_VOID_CHILDREN](#miu_e_web_jsx_void_children), [MIU_E_WEB_NO_NONCE](#miu_e_web_no_nonce), [MIU_E_WEB_VITE_DEV_UNREACHABLE](#miu_e_web_vite_dev_unreachable), [MIU_E_WEB_VITE_ENTRY](#miu_e_web_vite_entry), [MIU_E_WEB_VITE_MANIFEST](#miu_e_web_vite_manifest) |
| `@miujs/mail` | [MIU_E_MAIL_ADDRESS_INVALID](#miu_e_mail_address_invalid), [MIU_E_MAIL_API_KEY_MISSING](#miu_e_mail_api_key_missing), [MIU_E_MAIL_CONTENT_MISSING](#miu_e_mail_content_missing), [MIU_E_MAIL_HEADER_INVALID](#miu_e_mail_header_invalid), [MIU_E_MAIL_SEND_FAILED](#miu_e_mail_send_failed), [MIU_E_MAIL_TEMPLATE_UNKNOWN](#miu_e_mail_template_unknown), [MIU_E_MAIL_TIMEOUT](#miu_e_mail_timeout), [MIU_E_MAIL_TRANSPORT_MISSING](#miu_e_mail_transport_missing) |
| `@miujs/access` | [MIU_E_ACCESS_ALREADY_MEMBER](#miu_e_access_already_member), [MIU_E_ACCESS_APP_URL_MISSING](#miu_e_access_app_url_missing), [MIU_E_ACCESS_DATABASE_MISSING](#miu_e_access_database_missing), [MIU_E_ACCESS_EMAIL_UNVERIFIED](#miu_e_access_email_unverified), [MIU_E_ACCESS_INVITE_EMAIL_MISMATCH](#miu_e_access_invite_email_mismatch), [MIU_E_ACCESS_INVITE_EXPIRED](#miu_e_access_invite_expired), [MIU_E_ACCESS_INVITE_INVALID](#miu_e_access_invite_invalid), [MIU_E_ACCESS_INVITE_USED](#miu_e_access_invite_used), [MIU_E_ACCESS_LAST_OWNER](#miu_e_access_last_owner), [MIU_E_ACCESS_MAILER_MISSING](#miu_e_access_mailer_missing), [MIU_E_ACCESS_NO_ORG](#miu_e_access_no_org), [MIU_E_ACCESS_NOT_MEMBER](#miu_e_access_not_member), [MIU_E_ACCESS_OWNER_ROLE_MISSING](#miu_e_access_owner_role_missing), [MIU_E_ACCESS_PERMISSION_INVALID](#miu_e_access_permission_invalid), [MIU_E_ACCESS_PLUGIN_MISSING](#miu_e_access_plugin_missing), [MIU_E_ACCESS_POLICY_INVALID](#miu_e_access_policy_invalid), [MIU_E_ACCESS_ROLE_TOO_HIGH](#miu_e_access_role_too_high), [MIU_E_ACCESS_ROLE_UNKNOWN](#miu_e_access_role_unknown), [MIU_E_ACCESS_SESSION_MISSING](#miu_e_access_session_missing) |
| `@miujs/audit` | [MIU_E_AUDIT_ANCHOR_FAILED](#miu_e_audit_anchor_failed), [MIU_E_AUDIT_ANCHOR_INVALID](#miu_e_audit_anchor_invalid), [MIU_E_AUDIT_APPEND_CONFLICT](#miu_e_audit_append_conflict), [MIU_E_AUDIT_CHAIN_BROKEN](#miu_e_audit_chain_broken), [MIU_E_AUDIT_INVALID](#miu_e_audit_invalid), [MIU_E_AUDIT_KEY_MISSING](#miu_e_audit_key_missing), [MIU_E_AUDIT_KEY_WEAK](#miu_e_audit_key_weak), [MIU_E_AUDIT_ORG_MISMATCH](#miu_e_audit_org_mismatch), [MIU_E_AUDIT_QUERY_INVALID](#miu_e_audit_query_invalid), [MIU_E_AUDIT_RETENTION_INVALID](#miu_e_audit_retention_invalid), [MIU_E_AUDIT_SINK_INVALID](#miu_e_audit_sink_invalid), [MIU_E_AUDIT_SINK_MISSING](#miu_e_audit_sink_missing), [MIU_E_AUDIT_SINK_UNSUPPORTED](#miu_e_audit_sink_unsupported), [MIU_E_AUDIT_STORE_MISSING](#miu_e_audit_store_missing), [MIU_E_AUDIT_TABLE_INVALID](#miu_e_audit_table_invalid) |
| `@miujs/workflows` | [MIU_E_WORKFLOW_ACTION_UNKNOWN](#miu_e_workflow_action_unknown), [MIU_E_WORKFLOW_APPROVAL_NOT_PENDING](#miu_e_workflow_approval_not_pending), [MIU_E_WORKFLOW_CONFIG](#miu_e_workflow_config), [MIU_E_WORKFLOW_DUPLICATE](#miu_e_workflow_duplicate), [MIU_E_WORKFLOW_DURATION](#miu_e_workflow_duration), [MIU_E_WORKFLOW_EVENT_RESERVED](#miu_e_workflow_event_reserved), [MIU_E_WORKFLOW_EXPRESSION](#miu_e_workflow_expression), [MIU_E_WORKFLOW_MAILER_MISSING](#miu_e_workflow_mailer_missing), [MIU_E_WORKFLOW_NOT_APPROVER](#miu_e_workflow_not_approver), [MIU_E_WORKFLOW_RUN_NOT_FOUND](#miu_e_workflow_run_not_found), [MIU_E_WORKFLOW_RUN_STATE](#miu_e_workflow_run_state), [MIU_E_WORKFLOW_SIGNATURE](#miu_e_workflow_signature), [MIU_E_WORKFLOW_SPEC_INVALID](#miu_e_workflow_spec_invalid), [MIU_E_WORKFLOW_STEP_DUPLICATE](#miu_e_workflow_step_duplicate), [MIU_E_WORKFLOW_UNKNOWN](#miu_e_workflow_unknown) |
| `@miujs/ai` | [MIU_E_AI_AUTH](#miu_e_ai_auth), [MIU_E_AI_BAD_REQUEST](#miu_e_ai_bad_request), [MIU_E_AI_BINDING](#miu_e_ai_binding), [MIU_E_AI_CONFIG](#miu_e_ai_config), [MIU_E_AI_INVALID_OUTPUT](#miu_e_ai_invalid_output), [MIU_E_AI_MISSING_KEY](#miu_e_ai_missing_key), [MIU_E_AI_PROVIDER_ERROR](#miu_e_ai_provider_error), [MIU_E_AI_RATE_LIMITED](#miu_e_ai_rate_limited), [MIU_E_AI_REFUSED](#miu_e_ai_refused), [MIU_E_AI_TIMEOUT](#miu_e_ai_timeout), [MIU_E_AI_UNSUPPORTED](#miu_e_ai_unsupported) |
| `@miujs/admin` | [MIU_E_ADMIN_ACTION_UNKNOWN](#miu_e_admin_action_unknown), [MIU_E_ADMIN_CURSOR_INVALID](#miu_e_admin_cursor_invalid), [MIU_E_ADMIN_FIELDS_INVALID](#miu_e_admin_fields_invalid), [MIU_E_ADMIN_FILTER_INVALID](#miu_e_admin_filter_invalid), [MIU_E_ADMIN_HOOK_REJECTED](#miu_e_admin_hook_rejected), [MIU_E_ADMIN_IMPORT_EMPTY](#miu_e_admin_import_empty), [MIU_E_ADMIN_IMPORT_INVALID](#miu_e_admin_import_invalid), [MIU_E_ADMIN_IMPORT_TOO_LARGE](#miu_e_admin_import_too_large), [MIU_E_ADMIN_IN_USE](#miu_e_admin_in_use), [MIU_E_ADMIN_INCLUDE_INVALID](#miu_e_admin_include_invalid), [MIU_E_ADMIN_NO_TENANT](#miu_e_admin_no_tenant), [MIU_E_ADMIN_RECORD_NOT_FOUND](#miu_e_admin_record_not_found), [MIU_E_ADMIN_RELATION_INVALID](#miu_e_admin_relation_invalid), [MIU_E_ADMIN_RESOURCE_UNKNOWN](#miu_e_admin_resource_unknown), [MIU_E_ADMIN_SORT_INVALID](#miu_e_admin_sort_invalid), [MIU_E_ADMIN_UI_CONFIG](#miu_e_admin_ui_config), [MIU_E_ADMIN_UI_DATABASE](#miu_e_admin_ui_database), [MIU_E_ADMIN_UI_NO_ADMIN](#miu_e_admin_ui_no_admin), [MIU_E_ADMIN_UI_NOT_READY](#miu_e_admin_ui_not_ready), [MIU_E_ADMIN_UNIQUE](#miu_e_admin_unique), [MIU_E_ADMIN_VIEW_UNKNOWN](#miu_e_admin_view_unknown), [MIU_E_ADMIN_WORKFLOW_NAME_TAKEN](#miu_e_admin_workflow_name_taken), [MIU_E_ADMIN_WORKFLOW_PUBLISH](#miu_e_admin_workflow_publish), [MIU_E_ADMIN_WORKFLOWS_MISSING](#miu_e_admin_workflows_missing) |
| `@miujs/game` | [MIU_E_GAME_ACHIEVEMENT_INVALID](#miu_e_game_achievement_invalid), [MIU_E_GAME_ALREADY_QUEUED](#miu_e_game_already_queued), [MIU_E_GAME_CLIENT_SCORES_DISABLED](#miu_e_game_client_scores_disabled), [MIU_E_GAME_LEADERBOARD_CONFIG](#miu_e_game_leaderboard_config), [MIU_E_GAME_LOBBY_FULL](#miu_e_game_lobby_full), [MIU_E_GAME_LOBBY_NOT_FOUND](#miu_e_game_lobby_not_found), [MIU_E_GAME_LOBBY_NOT_HOST](#miu_e_game_lobby_not_host), [MIU_E_GAME_LOBBY_NOT_MEMBER](#miu_e_game_lobby_not_member), [MIU_E_GAME_LOBBY_NOT_READY](#miu_e_game_lobby_not_ready), [MIU_E_GAME_LOBBY_STARTED](#miu_e_game_lobby_started), [MIU_E_GAME_LOOP_NOT_DURABLE](#miu_e_game_loop_not_durable), [MIU_E_GAME_MATCH_FAILED](#miu_e_game_match_failed), [MIU_E_GAME_MATCH_TIMEOUT](#miu_e_game_match_timeout), [MIU_E_GAME_MATCH_UNKNOWN](#miu_e_game_match_unknown), [MIU_E_GAME_PLAYER_NOT_FOUND](#miu_e_game_player_not_found), [MIU_E_GAME_PROOF_INVALID](#miu_e_game_proof_invalid), [MIU_E_GAME_QUEUE_CONFIG](#miu_e_game_queue_config), [MIU_E_GAME_QUEUE_UNKNOWN](#miu_e_game_queue_unknown), [MIU_E_GAME_REGION_INVALID](#miu_e_game_region_invalid), [MIU_E_GAME_RESULT_INVALID](#miu_e_game_result_invalid), [MIU_E_GAME_RESULT_UNSIGNED](#miu_e_game_result_unsigned), [MIU_E_GAME_ROOM_CONFIG](#miu_e_game_room_config), [MIU_E_GAME_SCORE_INVALID](#miu_e_game_score_invalid), [MIU_E_GAME_SCORE_RATE_LIMITED](#miu_e_game_score_rate_limited), [MIU_E_GAME_SECRET_MISSING](#miu_e_game_secret_missing), [MIU_E_GAME_SECRET_WEAK](#miu_e_game_secret_weak), [MIU_E_GAME_STORE_MISSING](#miu_e_game_store_missing), [MIU_E_GAME_TICKET_EXPIRED](#miu_e_game_ticket_expired), [MIU_E_GAME_TICKET_INVALID](#miu_e_game_ticket_invalid), [MIU_E_GAME_TICKET_REQUIRED](#miu_e_game_ticket_required), [MIU_E_GAME_TICKET_USED](#miu_e_game_ticket_used), [MIU_E_GAME_TIMEZONE_INVALID](#miu_e_game_timezone_invalid) |
| `@miujs/migrate` | [MIU_E_MIGRATE_APP_KEY](#miu_e_migrate_app_key), [MIU_E_MIGRATE_CASES](#miu_e_migrate_cases), [MIU_E_MIGRATE_CONFIG](#miu_e_migrate_config), [MIU_E_MIGRATE_CSRF](#miu_e_migrate_csrf), [MIU_E_MIGRATE_DECRYPT](#miu_e_migrate_decrypt), [MIU_E_MIGRATE_NOT_PORTED](#miu_e_migrate_not_ported), [MIU_E_MIGRATE_OPENAPI](#miu_e_migrate_openapi), [MIU_E_MIGRATE_PHP_CLASS](#miu_e_migrate_php_class), [MIU_E_MIGRATE_PHP_SERIALIZE](#miu_e_migrate_php_serialize), [MIU_E_MIGRATE_PHP_UNSERIALIZE](#miu_e_migrate_php_unserialize), [MIU_E_MIGRATE_SECRET_KEY](#miu_e_migrate_secret_key), [MIU_E_MIGRATE_SIGNATURE](#miu_e_migrate_signature), [MIU_E_MIGRATE_SIGNATURE_EXPIRED](#miu_e_migrate_signature_expired), [MIU_E_MIGRATE_UPSTREAM](#miu_e_migrate_upstream), [MIU_E_MIGRATE_UPSTREAM_TIMEOUT](#miu_e_migrate_upstream_timeout), [MIU_E_MIGRATE_WEBSOCKET](#miu_e_migrate_websocket) |
| `@miujs/tour` | [MIU_E_TOUR_ANALYTICS_DISABLED](#miu_e_tour_analytics_disabled), [MIU_E_TOUR_ASSET_NOT_FOUND](#miu_e_tour_asset_not_found), [MIU_E_TOUR_ASSET_TYPE](#miu_e_tour_asset_type), [MIU_E_TOUR_CALLBACK_INVALID](#miu_e_tour_callback_invalid), [MIU_E_TOUR_CALLBACK_STALE](#miu_e_tour_callback_stale), [MIU_E_TOUR_CONFIG](#miu_e_tour_config), [MIU_E_TOUR_FILES_MISSING](#miu_e_tour_files_missing), [MIU_E_TOUR_FLOORPLAN_NOT_FOUND](#miu_e_tour_floorplan_not_found), [MIU_E_TOUR_GUIDE_ONLY](#miu_e_tour_guide_only), [MIU_E_TOUR_GUIDE_TOKEN](#miu_e_tour_guide_token), [MIU_E_TOUR_HOTSPOT_NOT_FOUND](#miu_e_tour_hotspot_not_found), [MIU_E_TOUR_INVALID](#miu_e_tour_invalid), [MIU_E_TOUR_JOBS_NOT_REGISTERED](#miu_e_tour_jobs_not_registered), [MIU_E_TOUR_LIVE_MISSING](#miu_e_tour_live_missing), [MIU_E_TOUR_LOCKED](#miu_e_tour_locked), [MIU_E_TOUR_NOT_FOUND](#miu_e_tour_not_found), [MIU_E_TOUR_PASSWORD_WRONG](#miu_e_tour_password_wrong), [MIU_E_TOUR_PROCESSOR_FAILED](#miu_e_tour_processor_failed), [MIU_E_TOUR_PROCESSOR_MISSING](#miu_e_tour_processor_missing), [MIU_E_TOUR_PROCESSOR_RESULT_INVALID](#miu_e_tour_processor_result_invalid), [MIU_E_TOUR_PROCESSOR_UNAVAILABLE](#miu_e_tour_processor_unavailable), [MIU_E_TOUR_QUEUE_MISSING](#miu_e_tour_queue_missing), [MIU_E_TOUR_RATE_LIMITED](#miu_e_tour_rate_limited), [MIU_E_TOUR_SCENE_NOT_FOUND](#miu_e_tour_scene_not_found), [MIU_E_TOUR_SECRET_MISSING](#miu_e_tour_secret_missing), [MIU_E_TOUR_SECRET_WEAK](#miu_e_tour_secret_weak), [MIU_E_TOUR_SLUG_TAKEN](#miu_e_tour_slug_taken), [MIU_E_TOUR_SOURCE_MISSING](#miu_e_tour_source_missing), [MIU_E_TOUR_STRICT_CDN](#miu_e_tour_strict_cdn), [MIU_E_TOUR_TOKEN_EXPIRED](#miu_e_tour_token_expired), [MIU_E_TOUR_TOKEN_INVALID](#miu_e_tour_token_invalid) |

## MIU_E_APP_NOT_READY

- **Package:** `miujs`
- **HTTP status:** 500
- **Source:** [`miujs/src/app.ts`](../packages/miujs/src/app.ts)

**What it means:** app.tools() was called before the app was ready

**How to fix:** Call `await app.ready()` first.

## MIU_E_APP_STARTED

- **Package:** `miujs`
- **HTTP status:** 500
- **Source:** [`miujs/src/app.ts`](../packages/miujs/src/app.ts)

**What it means:** Routes cannot be added after the app has started

**How to fix:** Add routes in `miu({ routes })` or in a plugin's `setup`.

## MIU_E_BAD_JSON

- **Package:** `miujs`, `@miujs/workflows`
- **HTTP status:** 400
- **Source:** [`miujs/src/app.ts`](../packages/miujs/src/app.ts), [`workflows/src/routes.ts`](../packages/workflows/src/routes.ts)

**What it means:**

- Request body is not valid JSON
- Webhook body is not valid JSON

**How to fix:**

- Send a JSON body with `content-type: application/json`.
- Send a JSON body.

## MIU_E_BAD_REQUEST

- **Package:** `miujs`
- **HTTP status:** 400
- **Source:** [`miujs/src/errors.ts`](../packages/miujs/src/errors.ts), [`miujs/src/websocket.ts`](../packages/miujs/src/websocket.ts)

**What it means:** The request is malformed in a way the route can't accept (for example unreadable JSON).

**Message:** WebSocket upgrade failed

**How to fix:** Read the message and `details` in the error body, then the source linked above.

## MIU_E_BODY_TOO_LARGE

- **Package:** `miujs`
- **HTTP status:** 413
- **Source:** [`miujs/src/app.ts`](../packages/miujs/src/app.ts), [`miujs/src/node.ts`](../packages/miujs/src/node.ts)

**What it means:** Request body is larger than {limit} bytes

**How to fix:**

- Send a smaller body, or raise the limit with `maxBodySize` on the route or in miu({ maxBodySize }).
- Send a smaller body, or raise maxBodySize.

## MIU_E_CLOUDFLARE_ASSETS_CONFLICT

- **Package:** `miujs`
- **HTTP status:** 500
- **Source:** [`miujs/src/app.ts`](../packages/miujs/src/app.ts)

**What it means:** Two plugins serve static assets from different folders: {assets.directory} and {next.directory}

**How to fix:** Workers has one static assets folder per app. Build everything into one folder, or serve only one plugin's assets.

## MIU_E_CONFLICT

- **Package:** `miujs`
- **HTTP status:** 409
- **Source:** [`miujs/src/errors.ts`](../packages/miujs/src/errors.ts)

**What it means:** The request conflicts with existing data, for example a duplicate unique value.

**How to fix:** Read the message and `details` in the error body, then the source linked above.

## MIU_E_COOKIE_VALUE_INVALID

- **Package:** `miujs`
- **HTTP status:** 500
- **Source:** [`miujs/src/cookies.ts`](../packages/miujs/src/cookies.ts)

**What it means:** Cookie "{name}" has characters not allowed in a raw cookie value

**How to fix:** Use only printable ASCII without spaces, quotes, commas, semicolons or backslashes, or leave encode on.

## MIU_E_FORBIDDEN

- **Package:** `miujs`
- **HTTP status:** 403
- **Source:** [`miujs/src/app.ts`](../packages/miujs/src/app.ts), [`miujs/src/errors.ts`](../packages/miujs/src/errors.ts)

**What it means:** The user is signed in but not allowed to do this (missing role or permission).

**Message:** Requires role: {or}

**How to fix:** Sign in as a user with the required role.

## MIU_E_INTERNAL

- **Package:** `miujs`, `@miujs/ai`
- **HTTP status:** 500
- **Source:** [`ai/src/sse.ts`](../packages/ai/src/sse.ts), [`miujs/src/app.ts`](../packages/miujs/src/app.ts), [`miujs/src/errors.ts`](../packages/miujs/src/errors.ts), [`miujs/src/node.ts`](../packages/miujs/src/node.ts)

**What it means:** An unexpected error. In production the message is hidden; check the server log for the cause.

**Message:**

- Stream failed
- Internal server error

**How to fix:** Read the message and `details` in the error body, then the source linked above.

## MIU_E_LISTEN_UNSUPPORTED

- **Package:** `miujs`
- **HTTP status:** 500
- **Source:** [`miujs/src/app.ts`](../packages/miujs/src/app.ts)

**What it means:** listen() is not available on {this.runtime}

**How to fix:** On Cloudflare Workers, `export default app` instead of calling listen().

## MIU_E_MCP_TOOL_DUPLICATE

- **Package:** `miujs`
- **HTTP status:** 500
- **Source:** [`miujs/src/app.ts`](../packages/miujs/src/app.ts)

**What it means:** MCP tool name "{tool}" is used by {prev} and {owner}

**How to fix:** Rename one of them (route `name`), or exclude one with `mcp: false`. Tool names keep only letters, digits, _ and -.

## MIU_E_METHOD_NOT_ALLOWED

- **Package:** `miujs`
- **HTTP status:** 405
- **Source:** [`miujs/src/app.ts`](../packages/miujs/src/app.ts)

**What it means:** {ctx.method} is not allowed on {ctx.path}

**How to fix:** Use one of: {…}.

## MIU_E_NOT_FOUND

- **Package:** `miujs`
- **HTTP status:** 404
- **Source:** [`miujs/src/errors.ts`](../packages/miujs/src/errors.ts)

**What it means:** A handler threw `errors.notFound()`: the resource it looked up does not exist.

**Message:** {resource} not found

**How to fix:** Read the message and `details` in the error body, then the source linked above.

## MIU_E_PARAM_MISSING

- **Package:** `miujs`
- **HTTP status:** 500
- **Source:** [`miujs/src/app.ts`](../packages/miujs/src/app.ts)

**What it means:** Route {def.method} {path} has :{missing} in the path, but the params schema does not declare it

**How to fix:** Add {missing}: t.string() (or another type) to the params schema.

## MIU_E_PARAM_SHADOWED

- **Package:** `miujs`
- **HTTP status:** 500
- **Source:** [`miujs/src/app.ts`](../packages/miujs/src/app.ts)

**What it means:** Route {def.method} {path} has "{shadow}" both as a path param and a query key

**How to fix:** Rename the query key (e.g. "{shadow}Filter") so the two can't be confused.

## MIU_E_PARAM_UNKNOWN

- **Package:** `miujs`
- **HTTP status:** 500
- **Source:** [`miujs/src/app.ts`](../packages/miujs/src/app.ts)

**What it means:** Route {def.method} {path} declares params.{unknown}, but the path has no :{unknown}

**How to fix:** Add :{unknown} to the path or remove it from the params schema.

## MIU_E_PERMISSION_UNCHECKED

- **Package:** `miujs`
- **HTTP status:** 500
- **Source:** [`miujs/src/app.ts`](../packages/miujs/src/app.ts)

**What it means:** Route {def.method} {path} requires permission "{permission}", but no plugin provides ctx.authorize

**How to fix:** Add an access plugin such as access({ roles }) from @miujs/access, or remove `permission` from the route.

## MIU_E_RATE_LIMITED

- **Package:** `miujs`
- **HTTP status:** 429
- **Source:** [`miujs/src/errors.ts`](../packages/miujs/src/errors.ts)

**What it means:** Too many requests in the current window. The response carries `Retry-After`.

**Message:** Too many requests

**How to fix:** Retry after {retryAfterSeconds} seconds. (otherwise: Slow down and retry later.)

## MIU_E_RESPONSE_INVALID

- **Package:** `miujs`
- **HTTP status:** 500
- **Source:** [`miujs/src/errors.ts`](../packages/miujs/src/errors.ts)

**What it means:** In dev, the handler returned data that doesn't match the route's `response` schema.

**Message:** Invalid {where}: {issues}

**How to fix:** The handler returned data that does not match the route's response schema. Fix the handler or the schema.

## MIU_E_ROUTE_CONFLICT

- **Package:** `miujs`
- **HTTP status:** 500
- **Source:** [`miujs/src/router.ts`](../packages/miujs/src/router.ts)

**What it means:** Route {path} uses :{name} where another route uses :{cur.param.name}

**How to fix:** Use the same parameter name (:{cur.param.name}) at this position in every route.

## MIU_E_ROUTE_DUPLICATE

- **Package:** `miujs`
- **HTTP status:** 500
- **Source:** [`miujs/src/router.ts`](../packages/miujs/src/router.ts)

**What it means:** Route {path} is defined twice

**How to fix:** Remove or rename one of the routes.

## MIU_E_ROUTE_INVALID

- **Package:** `miujs`
- **HTTP status:** 500
- **Source:** [`miujs/src/router.ts`](../packages/miujs/src/router.ts)

**What it means:** Wildcard must be the last segment in {path}

**How to fix:** Move `*name` to the end of the path.

## MIU_E_ROUTE_NAME_DUPLICATE

- **Package:** `miujs`
- **HTTP status:** 500
- **Source:** [`miujs/src/app.ts`](../packages/miujs/src/app.ts)

**What it means:** Two routes are named "{c.name}"

**How to fix:** Give one of them a different `name`, or export it under a different name.

## MIU_E_ROUTE_NOT_FOUND

- **Package:** `miujs`
- **HTTP status:** 404
- **Source:** [`miujs/src/app.ts`](../packages/miujs/src/app.ts)

**What it means:** No route for {ctx.method} {shown}

**How to fix:** Read the message and `details` in the error body, then the source linked above.

## MIU_E_SERVICE_DUPLICATE

- **Package:** `miujs`
- **HTTP status:** 500
- **Source:** [`miujs/src/app.ts`](../packages/miujs/src/app.ts)

**What it means:** Service "{name}" is provided twice

**How to fix:** Only one plugin may provide each service. Remove the duplicate plugin or rename one service.

## MIU_E_SERVICE_MISSING

- **Package:** `miujs`, `@miujs/workflows`
- **HTTP status:** 500
- **Source:** [`miujs/src/app.ts`](../packages/miujs/src/app.ts), [`workflows/src/cloudflare.ts`](../packages/workflows/src/cloudflare.ts), [`workflows/src/plugin.ts`](../packages/workflows/src/plugin.ts)

**What it means:**

- No plugin provides the "{name}" service
- No "{name}" service in this Cloudflare Workflow
- No app to look up the "{name}" service in

**How to fix:**

- Add the plugin that provides "{name}" to miu({ plugins }), and call app.service() after `await app.ready()`.
- Pass createCloudflareWorkflow(def, { services: { {name}: ... } }).
- Add workflows() to miu({ plugins }) and start runs after `await app.ready()`.

## MIU_E_UNAUTHORIZED

- **Package:** `miujs`
- **HTTP status:** 401
- **Source:** [`miujs/src/app.ts`](../packages/miujs/src/app.ts), [`miujs/src/errors.ts`](../packages/miujs/src/errors.ts)

**What it means:** The route needs a signed-in user (`auth: "required"` or a role) and the request has none.

**Message:** Authentication required

**How to fix:** Sign in, or send `Authorization: Bearer <token>`.

## MIU_E_VALIDATION

- **Package:** `miujs`, `@miujs/queue`, `@miujs/workflows`
- **HTTP status:** 400
- **Source:** [`miujs/src/errors.ts`](../packages/miujs/src/errors.ts), [`queue/src/errors.ts`](../packages/queue/src/errors.ts), [`workflows/src/errors.ts`](../packages/workflows/src/errors.ts)

**What it means:** Params, query, body or headers don't match the route's `t` schema. `details.issues` lists each problem with its path.

**Message:**

- Invalid {where}: {issues}
- Invalid input for job "{job}": {issues}
- Invalid input for workflow "{workflow}": {issues}

**How to fix:**

- Send {where} that matches the route schema (see /_miu/openapi.json or the MCP tool input schema).
- Pass input that matches the `input` schema in defineJob("{job}", ...) (see miu inspect).
- Pass input that matches the `input` schema of workflow "{workflow}" (see GET /workflows).

## MIU_E_WS_EXPECTED

- **Package:** `miujs`, `@miujs/realtime`, `@miujs/game`
- **HTTP status:** 426
- **Source:** [`game/src/cloudflare.ts`](../packages/game/src/cloudflare.ts), [`miujs/src/websocket.ts`](../packages/miujs/src/websocket.ts), [`realtime/src/cloudflare.ts`](../packages/realtime/src/cloudflare.ts)

**What it means:** This route only accepts WebSocket connections

**How to fix:**

- Connect with a WebSocket client.
- Connect with a WebSocket client (ws:// or wss://), not plain HTTP.
- Connect with a WebSocket client (ws:// or wss://).

## MIU_E_WS_UNSUPPORTED

- **Package:** `miujs`
- **HTTP status:** 501
- **Source:** [`miujs/src/websocket.ts`](../packages/miujs/src/websocket.ts)

**What it means:** WebSockets are not supported on runtime "{ctx.runtime}" yet

**How to fix:** Run realtime routes on Bun, Deno or Cloudflare Workers.

## MIU_E_CLI_ADD_USAGE

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/index.ts`](../packages/cli/src/index.ts)

**What it means:** Usage: miu add &lt;kind&gt; &lt;name&gt;

**How to fix:** &lt;kind&gt; is one of: {…}.

## MIU_E_CLI_BUILD_FAILED

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/deploy.ts`](../packages/cli/src/deploy.ts)

**What it means:** bun build --compile failed: {r.stderr}

**How to fix:** Fix the errors above; `bun build --compile .miu/server.ts` reproduces them.

## MIU_E_CLI_DB_NOT_FOUND

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/db.ts`](../packages/cli/src/db.ts)

**What it means:** Database file {given} does not exist

**How to fix:** Pass the path of your local SQLite file with --db, or --d1 &lt;database-name&gt; for a remote D1 database.

## MIU_E_CLI_DB_SOURCE

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/db.ts`](../packages/cli/src/db.ts)

**What it means:** Several database files here ({…}); which one? (otherwise: No database given)

**How to fix:** Pass --db &lt;file.sqlite&gt; for a local SQLite file, or --d1 &lt;database-name&gt; for a remote Cloudflare D1 database (uses `bunx wrangler d1 execute --remote`).

## MIU_E_CLI_DB_USAGE

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/db.ts`](../packages/cli/src/db.ts)

**What it means:**

- --generate needs the schema to compare against
- --schema is only used with --generate
- Unknown db command "{sub}"

**How to fix:**

- Pass --schema &lt;file.ts&gt; (the module that exports your Drizzle sqliteTable()s), e.g. `miu db migrate --generate add_posts --schema db/schema.ts`.
- Run `miu db migrate --generate <name> --schema <file.ts>` to write a migration, or drop --schema to apply migrations.
- Use `miu db pull [--db file | --d1 name]` or `miu db migrate [--dir migrations] [--db file | --d1 name]`.

## MIU_E_CLI_DENO_JSON

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/deploy.ts`](../packages/cli/src/deploy.ts)

**What it means:** deno.json is not valid JSON

**How to fix:** Fix deno.json (or delete it) and re-run.

## MIU_E_CLI_DEPLOY_TARGET

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/deploy.ts`](../packages/cli/src/deploy.ts)

**What it means:** Unknown deploy target "{target}"

**How to fix:** Use `miu deploy <target>` with one of: {…}.

## MIU_E_CLI_DRIZZLE_MISSING

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/db.ts`](../packages/cli/src/db.ts)

**What it means:** Could not load drizzle-orm: {err}

**How to fix:** Install it in your app: `bun add drizzle-orm`.

## MIU_E_CLI_EXISTS

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/deploy.ts`](../packages/cli/src/deploy.ts), [`cli/src/index.ts`](../packages/cli/src/index.ts), [`cli/src/util.ts`](../packages/cli/src/util.ts)

**What it means:**

- {out} already exists
- {dir} already exists and is not empty
- {file} already exists

**How to fix:**

- Re-run with --force to overwrite it, or --dry-run --out other.toml to compare.
- Pick another folder name.
- Pick another name or delete the existing file first.

## MIU_E_CLI_FLAG_VALUE

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/loadtest.ts`](../packages/cli/src/loadtest.ts), [`cli/src/util.ts`](../packages/cli/src/util.ts)

**What it means:**

- --action {v} has no "type"
- --action frame has t "{o.t}"; only "msg" frames are actions
- --action is not valid JSON: {text}
- --action is an empty list
- --{key} does not take a value
- --{key} needs a value

**How to fix:**

- Write --action '{"type":"answer","data":{"choice":1}}' (the room message name and its data).
- Write --action '{"t":"msg","type":"answer","data":{...}}' or just '{"type":"answer","data":{...}}'.
- Quote it for your shell, e.g. --action '{"type":"inc","data":{"by":1}}'.
- Give at least one action.
- Write --{key} on its own.
- Write --{key} &lt;value&gt; or --{key}=&lt;value&gt;.

## MIU_E_CLI_LOADTEST_USAGE

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/loadtest.ts`](../packages/cli/src/loadtest.ts)

**What it means:** {url} is not a WebSocket URL (otherwise: miu loadtest needs the room's WebSocket URL)

**How to fix:** Pass a ws:// or wss:// room URL, e.g. `miu loadtest ws://localhost:3000/rooms/quiz/r1 --players 50 --duration 10s --action '{"type":"answer","data":{"choice":1}}'`.

## MIU_E_CLI_LOGS_FILE

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/logs.ts`](../packages/cli/src/logs.ts)

**What it means:** Log file {file} does not exist

**How to fix:** Point --file at the file your app writes its JSON log lines to (e.g. `bun app.ts > app.log`).

## MIU_E_CLI_LOGS_SOURCE

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/logs.ts`](../packages/cli/src/logs.ts)

**What it means:** No log source: no --file and no wrangler config here

**How to fix:** Pass --file app.log for a local app (run it with `bun app.ts > app.log`), or --worker &lt;name&gt; (or run in the folder with wrangler.toml) to tail Cloudflare.

## MIU_E_CLI_NEW_USAGE

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/index.ts`](../packages/cli/src/index.ts)

**What it means:** Usage: miu new &lt;dir&gt; [--template api]

**How to fix:** Pass the folder name for the new project.

## MIU_E_CLI_NO_APP

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/util.ts`](../packages/cli/src/util.ts)

**What it means:**

- Entry file {given} does not exist
- No app entry found in {cwd}

**How to fix:**

- Pass the path to the file that default-exports your app.
- Create app.ts with `export default miu({...})`, or pass the entry path (tried {…}).

## MIU_E_CLI_NO_DEFAULT_EXPORT

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/util.ts`](../packages/cli/src/util.ts)

**What it means:** {entry} does not default-export a MiuJS app

**How to fix:** Add `export default miu({ ... })` to the entry file.

## MIU_E_CLI_SCHEMA_EMPTY

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/db.ts`](../packages/cli/src/db.ts)

**What it means:** {schemaPath} exports no Drizzle tables

**How to fix:** Export your tables from it: `export const users = sqliteTable("users", { ... })`.

## MIU_E_CLI_SCHEMA_NOT_FOUND

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/db.ts`](../packages/cli/src/db.ts)

**What it means:** Schema file {schemaPath} does not exist

**How to fix:** Pass the path of the module that exports your Drizzle tables with --schema.

## MIU_E_CLI_TEMPLATE

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/index.ts`](../packages/cli/src/index.ts)

**What it means:** Unknown template "{template}"

**How to fix:** Use --template with one of: {TEMPLATES}.

## MIU_E_CLI_UNKNOWN_COMMAND

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/index.ts`](../packages/cli/src/index.ts)

**What it means:** Unknown command "{command}"

**How to fix:** Run `miu help` to see the commands.

## MIU_E_CLI_UNKNOWN_FLAG

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/util.ts`](../packages/cli/src/util.ts)

**What it means:** Unknown flag --{key} for `miu {command}`

**How to fix:** Valid flags: {…}. Run `miu help` for details. (otherwise: `miu {command}` takes no flags. Run `miu help` for details.)

## MIU_E_CLI_WRANGLER

- **Package:** `@miujs/cli`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`cli/src/db.ts`](../packages/cli/src/db.ts), [`cli/src/logs.ts`](../packages/cli/src/logs.ts)

**What it means:**

- wrangler d1 execute {name} failed: {r.stderr}
- wrangler d1 execute {name} printed something that is not JSON: {…}
- wrangler tail failed: {r.stderr}

**How to fix:**

- Run `bunx wrangler login`, and check that "{name}" is the database_name of a [[d1_databases]] entry in wrangler.toml (`bunx wrangler d1 list`).
- Update wrangler (`bunx wrangler --version` should be 3.x or newer) and try again.
- Run `bunx wrangler login` and check the worker name (`--worker <name>` or `name` in wrangler.toml); the worker must be deployed.

## MIU_E_NOT_IMPLEMENTED

- **Package:** `@miujs/cli`
- **HTTP status:** 501
- **Source:** [`cli/src/templates.ts`](../packages/cli/src/templates.ts)

**What it means:** ${exportName} is not implemented yet

**How to fix:** Write the handler in ${file}.

## MIU_W_DO_NOT_EXPORTED

- **Package:** `@miujs/cli`
- **HTTP status:** none (warning)
- **Source:** [`cli/src/deploy.ts`](../packages/cli/src/deploy.ts)

**What it means:** See the source; this code has no static message.

**How to fix:** Read the message and `details` in the error body, then the source linked above.

## MIU_W_SECRET_IN_CODE

- **Package:** `@miujs/cli`
- **HTTP status:** none (warning)
- **Source:** [`cli/src/check.ts`](../packages/cli/src/check.ts)

**What it means:** {io.cwd}:{i} looks like a {p.name}.

**How to fix:** move it to an env var or a Cloudflare secret and rotate it.

## MIU_W_TYPECHECK

- **Package:** `@miujs/cli`
- **HTTP status:** none (warning)
- **Source:** [`cli/src/check.ts`](../packages/cli/src/check.ts)

**What it means:** See the source; this code has no static message.

**How to fix:** Read the message and `details` in the error body, then the source linked above.

## MIU_W_UNAUTHENTICATED_MUTATION

- **Package:** `@miujs/cli`
- **HTTP status:** none (warning)
- **Source:** [`cli/src/check.ts`](../packages/cli/src/check.ts)

**What it means:** {r.method} {r.path} ({r.name}) has no auth.

**How to fix:** add `auth: "required"`, or `auth: "optional"` if it is public on purpose.

## MIU_W_WORKERS_BUNDLE

- **Package:** `@miujs/cli`
- **HTTP status:** none (warning)
- **Source:** [`cli/src/check.ts`](../packages/cli/src/check.ts)

**What it means:** See the source; this code has no static message.

**How to fix:** Read the message and `details` in the error body, then the source linked above.

## MIU_W_WORKERS_NODE_IMPORT

- **Package:** `@miujs/cli`
- **HTTP status:** none (warning)
- **Source:** [`cli/src/check.ts`](../packages/cli/src/check.ts)

**What it means:** {where} imports {f.specifier}, which Cloudflare Workers cannot load.

**How to fix:** move it behind a runtime check (`if (detectRuntime() === "bun") await import(...)`

## MIU_W_WORKFLOW_NOT_EXPORTED

- **Package:** `@miujs/cli`
- **HTTP status:** none (warning)
- **Source:** [`cli/src/deploy.ts`](../packages/cli/src/deploy.ts)

**What it means:** binding {w.binding} needs the Workflow class {w.className}, but {entryRel} does not export it.

**How to fix:** add `export const {w.className} = createCloudflareWorkflow(...)` to {entryRel}.

## MIU_E_AUTH_APP_URL_INVALID

- **Package:** `@miujs/auth`
- **HTTP status:** 500
- **Source:** [`auth/src/index.ts`](../packages/auth/src/index.ts)

**What it means:** appUrl {opts.appUrl} is not an http(s) URL

**How to fix:** Pass auth({ appUrl: "https://app.example.com" }).

## MIU_E_AUTH_APP_URL_MISSING

- **Package:** `@miujs/auth`
- **HTTP status:** 500
- **Source:** [`auth/src/index.ts`](../packages/auth/src/index.ts)

**What it means:** No public app URL for links in account emails

**How to fix:** Pass auth({ appUrl: "https://your-app.example" }) or set the APP_URL env var. Links are never built from the Host header in production (it can be forged).

## MIU_E_AUTH_EMAIL_TAKEN

- **Package:** `@miujs/auth`
- **HTTP status:** 409
- **Source:** [`auth/src/index.ts`](../packages/auth/src/index.ts)

**What it means:** An account with this email already exists

**How to fix:** Sign in with POST /auth/login instead, or use another email.

## MIU_E_AUTH_EMAIL_UNVERIFIED

- **Package:** `@miujs/auth`
- **HTTP status:** 403
- **Source:** [`auth/src/index.ts`](../packages/auth/src/index.ts)

**What it means:** Confirm your email address before signing in

**How to fix:** Open the link in the confirmation email we sent. To get a new one, POST { "email" } to {base}/verify-email/request.

## MIU_E_AUTH_HASH_UNSUPPORTED

- **Package:** `@miujs/auth`
- **HTTP status:** 500
- **Source:** [`auth/src/password.ts`](../packages/auth/src/password.ts)

**What it means:** Cannot verify {kind} password hashes on this runtime

**How to fix:** bcrypt and argon2 hashes need Bun (Bun.password). Run on Bun, or have users reset their password so it is stored as pbkdf2_sha256.

## MIU_E_AUTH_INVALID

- **Package:** `@miujs/auth`
- **HTTP status:** 401
- **Source:** [`auth/src/index.ts`](../packages/auth/src/index.ts)

**What it means:** Invalid email or password

**How to fix:** Check the email and password. Register first if you do not have an account.

## MIU_E_AUTH_MAILER_MISSING

- **Package:** `@miujs/auth`
- **HTTP status:** 500
- **Source:** [`auth/src/index.ts`](../packages/auth/src/index.ts)

**What it means:** Email verification and password reset need a way to send email

**How to fix:** Add mail({ transport, from }) from @miujs/mail to plugins, or pass auth({ mailer: { send } }).

## MIU_E_AUTH_OAUTH_ACCOUNT_EXISTS

- **Package:** `@miujs/auth`
- **HTTP status:** 409
- **Source:** [`auth/src/oauth.ts`](../packages/auth/src/oauth.ts)

**What it means:** An account with the email {p.id} reported already exists

**How to fix:** An account with this email already exists. Sign in with your password, then link {p.id} from your account settings.

## MIU_E_AUTH_OAUTH_ALREADY_LINKED

- **Package:** `@miujs/auth`
- **HTTP status:** 409
- **Source:** [`auth/src/oauth.ts`](../packages/auth/src/oauth.ts)

**What it means:** This {p.id} account is already linked, or you already have another {p.id} account linked

**How to fix:** Unlink it first with DELETE {deps.base}/oauth/accounts/{p.id} from the account that has it, then link again.

## MIU_E_AUTH_OAUTH_CLIENT_SECRET_MISSING

- **Package:** `@miujs/auth`
- **HTTP status:** 500
- **Source:** [`auth/src/oauth.ts`](../packages/auth/src/oauth.ts)

**What it means:**

- No client secret for the {id} OAuth provider
- No private key for Sign in with Apple

**How to fix:**

- Set the {id} environment variable, or pass auth({ oauth: { {id}: { clientSecret } } }).
- Set APPLE_PRIVATE_KEY to the contents of the .p8 key file, or pass auth({ oauth: { apple: { privateKey } } }).

## MIU_E_AUTH_OAUTH_CONFIG

- **Package:** `@miujs/auth`
- **HTTP status:** 500
- **Source:** [`auth/src/oauth.ts`](../packages/auth/src/oauth.ts), [`auth/src/passkeys.ts`](../packages/auth/src/passkeys.ts)

**What it means:**

- The Apple private key could not be read ({err})
- OAuth provider id {p.id} is not valid
- OAuth provider "{p.id}" is configured twice
- OAuth provider "{p.id}" has no clientId
- OIDC issuer for "{p.id}" must be an https URL
- OIDC provider "{p.id}" needs the "openid" scope

**How to fix:**

- Use the .p8 file from Apple as-is: a PKCS#8 PEM starting with -----BEGIN PRIVATE KEY-----.
- Use lowercase letters, digits, - and _ (max 32), e.g. { id: "okta" }.
- Give each oidc provider a unique id that is not google, github, apple or discord.
- Pass the client id from the provider's console: auth({ oauth: { {p.id}: { clientId } } }).
- Use the issuer exactly as the provider publishes it, e.g. "https://example.okta.com".
- Add "openid" to scopes so the provider returns an id_token.

## MIU_E_AUTH_OAUTH_CONFLICT

- **Package:** `@miujs/auth`
- **HTTP status:** 409
- **Source:** [`auth/src/oauth.ts`](../packages/auth/src/oauth.ts)

**What it means:** This account changed while signing in

**How to fix:** Start sign-in again.

## MIU_E_AUTH_OAUTH_DENIED

- **Package:** `@miujs/auth`
- **HTTP status:** 400
- **Source:** [`auth/src/oauth.ts`](../packages/auth/src/oauth.ts)

**What it means:** {p.id} did not complete sign-in ({reason})

**How to fix:** Try again and approve access at the provider.

## MIU_E_AUTH_OAUTH_DISCOVERY

- **Package:** `@miujs/auth`
- **HTTP status:** 502
- **Source:** [`auth/src/oauth.ts`](../packages/auth/src/oauth.ts)

**What it means:** OpenID discovery for "{p.id}" failed: {why}

**How to fix:** Check that the issuer ({p.issuer}) is right and serves /.well-known/openid-configuration.

## MIU_E_AUTH_OAUTH_EMAIL_UNVERIFIED

- **Package:** `@miujs/auth`
- **HTTP status:** 403
- **Source:** [`auth/src/oauth.ts`](../packages/auth/src/oauth.ts)

**What it means:**

- {p.id} did not confirm an email address for this account
- This account's email address is not confirmed

**How to fix:**

- Confirm your email address with {p.id} (or make it your primary one) and sign in again, or register with email and password.
- Confirm your email address, or sign in with a provider that has confirmed it.

## MIU_E_AUTH_OAUTH_ID_TOKEN

- **Package:** `@miujs/auth`
- **HTTP status:** 401
- **Source:** [`auth/src/oauth.ts`](../packages/auth/src/oauth.ts)

**What it means:** The provider's id_token was rejected: {why}

**How to fix:** Check the provider's clientId and issuer in auth({ oauth }); if they are right, start sign-in again.

## MIU_E_AUTH_OAUTH_LAST_METHOD

- **Package:** `@miujs/auth`
- **HTTP status:** 409
- **Source:** [`auth/src/oauth.ts`](../packages/auth/src/oauth.ts)

**What it means:** {ctx.params.provider} is your only way to sign in

**How to fix:** Add another way to sign in first: set a password (POST {deps.base}/password/forgot), add a passkey, or link another provider. Then unlink {ctx.params.provider}.

## MIU_E_AUTH_OAUTH_PROFILE

- **Package:** `@miujs/auth`
- **HTTP status:** 502
- **Source:** [`auth/src/oauth.ts`](../packages/auth/src/oauth.ts)

**What it means:**

- Reading the GitHub profile failed: {why}
- Reading the Discord profile failed: {why}

**How to fix:**

- Check that the GitHub app requests the read:user and user:email scopes.
- Check that the Discord app requests the identify and email scopes.

## MIU_E_AUTH_OAUTH_PROVIDER_UNKNOWN

- **Package:** `@miujs/auth`
- **HTTP status:** 404
- **Source:** [`auth/src/oauth.ts`](../packages/auth/src/oauth.ts)

**What it means:** No OAuth provider named {id}

**How to fix:** Use one of: {…}. Add others in auth({ oauth }).

## MIU_E_AUTH_OAUTH_RETURN_TO

- **Package:** `@miujs/auth`
- **HTTP status:** 400
- **Source:** [`auth/src/oauth.ts`](../packages/auth/src/oauth.ts)

**What it means:** returnTo must be a path on this site

**How to fix:** Pass a relative path such as "/dashboard" (starting with a single "/").

## MIU_E_AUTH_OAUTH_SESSION_REQUIRED

- **Package:** `@miujs/auth`
- **HTTP status:** 403
- **Source:** [`auth/src/oauth.ts`](../packages/auth/src/oauth.ts)

**What it means:** Linking a sign-in provider needs a signed-in browser session

**How to fix:** Sign in in the browser (not with an API token), then open the link from your account settings.

## MIU_E_AUTH_OAUTH_STATE

- **Package:** `@miujs/auth`
- **HTTP status:** 400
- **Source:** [`auth/src/oauth.ts`](../packages/auth/src/oauth.ts)

**What it means:** OAuth sign-in could not be verified: {why}

**How to fix:** Start again from the sign-in button (GET /auth/oauth/:provider) in the same browser, and finish within 10 minutes. Cookies must be enabled.

## MIU_E_AUTH_OAUTH_STATE_SECRET_MISSING

- **Package:** `@miujs/auth`
- **HTTP status:** 500
- **Source:** [`auth/src/oauth.ts`](../packages/auth/src/oauth.ts)

**What it means:** No secret to sign the OAuth state cookie

**How to fix:** Set the SESSION_SECRET (or AUTH_SECRET) environment variable to a random string of 32+ characters, or pass auth({ oauth: { secret } }).

## MIU_E_AUTH_OAUTH_TOKEN

- **Package:** `@miujs/auth`
- **HTTP status:** 502
- **Source:** [`auth/src/oauth.ts`](../packages/auth/src/oauth.ts)

**What it means:** Exchanging the code with "{p.id}" failed: {why}

**How to fix:** Check the {p.id} clientId/clientSecret and that {…}&lt;appUrl&gt;{deps.base}/oauth/{p.id}/callback{…} is registered as a redirect URI at the provider.

## MIU_E_AUTH_PASSKEY_ALGORITHM

- **Package:** `@miujs/auth`
- **HTTP status:** 400
- **Source:** [`auth/src/passkeys.ts`](../packages/auth/src/passkeys.ts)

**What it means:** Passkey algorithm {alg} is not supported

**How to fix:** Offer ES256 (-7) or RS256 (-257): use pubKeyCredParams from /auth/passkeys/register/options as-is.

## MIU_E_AUTH_PASSKEY_ATTESTATION

- **Package:** `@miujs/auth`
- **HTTP status:** 400
- **Source:** [`auth/src/passkeys.ts`](../packages/auth/src/passkeys.ts)

**What it means:** Attestation format {fmt} is not accepted

**How to fix:** Request options from /auth/passkeys/register/options (attestation: "none") and pass them to navigator.credentials.create() unchanged.

## MIU_E_AUTH_PASSKEY_CHALLENGE

- **Package:** `@miujs/auth`
- **HTTP status:** 400
- **Source:** [`auth/src/passkeys.ts`](../packages/auth/src/passkeys.ts)

**What it means:** The passkey challenge is unknown, already used or expired

**How to fix:** Request new options with POST /auth/passkeys/{phase}/options and finish within 5 minutes. Each challenge works once.

## MIU_E_AUTH_PASSKEY_CLONED

- **Package:** `@miujs/auth`
- **HTTP status:** 401
- **Source:** [`auth/src/passkeys.ts`](../packages/auth/src/passkeys.ts)

**What it means:** This passkey's signature counter went backwards; it may have been copied

**How to fix:** Remove this passkey (DELETE /auth/passkeys/:id) from a signed-in session and register a new one.

## MIU_E_AUTH_PASSKEY_CONFIG

- **Package:** `@miujs/auth`
- **HTTP status:** 500
- **Source:** [`auth/src/passkeys.ts`](../packages/auth/src/passkeys.ts)

**What it means:** See the source; this code has no static message.

**How to fix:** Read the message and `details` in the error body, then the source linked above.

## MIU_E_AUTH_PASSKEY_EXISTS

- **Package:** `@miujs/auth`
- **HTTP status:** 409
- **Source:** [`auth/src/passkeys.ts`](../packages/auth/src/passkeys.ts)

**What it means:** This passkey is already registered

**How to fix:** Use it to sign in, or remove it first with DELETE /auth/passkeys/:id.

## MIU_E_AUTH_PASSKEY_FLAGS

- **Package:** `@miujs/auth`
- **HTTP status:** 400, 401
- **Source:** [`auth/src/passkeys.ts`](../packages/auth/src/passkeys.ts)

**What it means:**

- The authenticator did not confirm user presence
- The authenticator did not verify the user (PIN or biometric)

**How to fix:**

- Touch or confirm on the authenticator when the browser asks.
- Use an authenticator with a PIN or biometric, or set auth({ passkeys: { userVerification: "preferred" } }).

## MIU_E_AUTH_PASSKEY_INVALID

- **Package:** `@miujs/auth`
- **HTTP status:** 400, 401
- **Source:** [`auth/src/passkeys.ts`](../packages/auth/src/passkeys.ts)

**What it means:** Passkey response rejected: {why}

**How to fix:** Send the credential exactly as the browser returned it (credential.toJSON()), for options you just requested.

## MIU_E_AUTH_PASSKEY_ORIGIN

- **Package:** `@miujs/auth`
- **HTTP status:** 400
- **Source:** [`auth/src/passkeys.ts`](../packages/auth/src/passkeys.ts)

**What it means:** Passkey used from an origin that is not allowed ({…})

**How to fix:** Add the site's origin to auth({ passkeys: { origins } }). Allowed now: {…}. Cross-origin iframes are refused.

## MIU_E_AUTH_PASSKEY_RP_ID

- **Package:** `@miujs/auth`
- **HTTP status:** 400
- **Source:** [`auth/src/passkeys.ts`](../packages/auth/src/passkeys.ts)

**What it means:** The passkey was made for another site (rpIdHash mismatch)

**How to fix:** Use rp.id / rpId exactly as returned by the options route ("{o.rpId}").

## MIU_E_AUTH_PASSKEY_SESSION_REQUIRED

- **Package:** `@miujs/auth`
- **HTTP status:** 403
- **Source:** [`auth/src/passkeys.ts`](../packages/auth/src/passkeys.ts)

**What it means:** Passkeys can only be added from a signed-in browser session

**How to fix:** Sign in with a password (or an existing passkey) in the browser, then add the passkey there; API tokens cannot add passkeys.

## MIU_E_AUTH_PASSWORD_INCORRECT

- **Package:** `@miujs/auth`
- **HTTP status:** 403
- **Source:** [`auth/src/index.ts`](../packages/auth/src/index.ts)

**What it means:** The current password is incorrect

**How to fix:** Send your current password as currentPassword. Forgot it? Use POST {base}/password/forgot.

## MIU_E_AUTH_PASSWORD_WEAK

- **Package:** `@miujs/auth`
- **HTTP status:** 400
- **Source:** [`auth/src/index.ts`](../packages/auth/src/index.ts)

**What it means:** Password must be {minLen}–{MAX_PASSWORD} characters

**How to fix:** Choose a password of at least {minLen} characters (a passphrase works well).

## MIU_E_AUTH_RATELIMIT_BINDING

- **Package:** `@miujs/auth`
- **HTTP status:** 500
- **Source:** [`auth/src/ratelimit.ts`](../packages/auth/src/ratelimit.ts)

**What it means:** Rate limit binding "{binding}" is not configured

**How to fix:** Add a [[ratelimits]] binding named {binding} to wrangler.toml, or use memoryRateLimiter().

## MIU_E_AUTH_RESET_INVALID

- **Package:** `@miujs/auth`
- **HTTP status:** 400
- **Source:** [`auth/src/index.ts`](../packages/auth/src/index.ts)

**What it means:** This password reset link is invalid, used or expired

**How to fix:** Ask for a new link with POST {base}/password/forgot. Links work once and expire after 1 hour.

## MIU_E_AUTH_SESSION_REQUIRED

- **Package:** `@miujs/auth`
- **HTTP status:** 500
- **Source:** [`auth/src/index.ts`](../packages/auth/src/index.ts)

**What it means:**

- auth() needs the session plugin
- auth() needs session() earlier in plugins

**How to fix:**

- Add session() before auth() in miu({ plugins: [session(), auth()] }).
- Use miu({ plugins: [session(), auth()] }).

## MIU_E_AUTH_STORE_UNSUPPORTED

- **Package:** `@miujs/auth`
- **HTTP status:** 500
- **Source:** [`auth/src/index.ts`](../packages/auth/src/index.ts)

**What it means:** The {users.kind} user store lacks {…}, needed for {feature}

**How to fix:** Use memoryUserStore() or dbUserStore(db), or implement those UserStore methods in your store.

## MIU_E_AUTH_TOKEN_INVALID

- **Package:** `@miujs/auth`
- **HTTP status:** 401
- **Source:** [`auth/src/index.ts`](../packages/auth/src/index.ts)

**What it means:** Invalid or expired API token

**How to fix:** Create a new token with POST /auth/tokens and send it as `Authorization: Bearer <token>`.

## MIU_E_AUTH_TURNSTILE_FAILED

- **Package:** `@miujs/auth`
- **HTTP status:** 403
- **Source:** [`auth/src/index.ts`](../packages/auth/src/index.ts)

**What it means:** Bot check failed: {why}

**How to fix:** Render the Cloudflare Turnstile widget in the form and send its token as `cf-turnstile-response`.

## MIU_E_AUTH_TURNSTILE_SECRET_MISSING

- **Package:** `@miujs/auth`
- **HTTP status:** 500
- **Source:** [`auth/src/index.ts`](../packages/auth/src/index.ts)

**What it means:** Turnstile is on but no secret key is set

**How to fix:** Set TURNSTILE_SECRET_KEY or pass auth({ turnstile: { secretKey } }).

## MIU_E_AUTH_VERIFY_INVALID

- **Package:** `@miujs/auth`
- **HTTP status:** 400
- **Source:** [`auth/src/index.ts`](../packages/auth/src/index.ts)

**What it means:** This email confirmation link is invalid, used or expired

**How to fix:** Request a new link with POST {base}/verify-email/request. Links work once and expire after 24 hours.

## MIU_E_CSRF

- **Package:** `@miujs/session`
- **HTTP status:** 403
- **Source:** [`session/src/index.ts`](../packages/session/src/index.ts)

**What it means:** Cross-site request blocked: the Origin/Referer does not match this site

**How to fix:** Send the request from the same origin (browsers add the Origin header). For another trusted site add it to session({ trustedOrigins }); for webhooks tag the route `csrf-exempt`; API clients should use `Authorization: Bearer` without cookies.

## MIU_E_SESSION_KV_MISSING

- **Package:** `@miujs/session`
- **HTTP status:** 500
- **Source:** [`session/src/stores.ts`](../packages/session/src/stores.ts)

**What it means:** No KV binding named "{binding}" in env

**How to fix:** Add a [[kv_namespaces]] entry with binding = "{binding}" to wrangler.toml (or run `miu deploy cloudflare`).

## MIU_E_SESSION_REDIS

- **Package:** `@miujs/session`
- **HTTP status:** 500
- **Source:** [`session/src/stores.ts`](../packages/session/src/stores.ts)

**What it means:** Redis {op} for a session failed: {err}

**How to fix:** Check that Redis is running and reachable at REDIS_URL (or the url passed to bunRedis()), with the right credentials and TLS settings.

## MIU_E_SESSION_REDIS_CLIENT

- **Package:** `@miujs/session`
- **HTTP status:** 500
- **Source:** [`session/src/stores.ts`](../packages/session/src/stores.ts)

**What it means:** redisSessionStore needs a Redis client with get/set/del

**How to fix:** Pass bunRedis() from @miujs/cache on Bun, or any client wrapped with redisFromCommand(...).

## MIU_E_SESSION_SECRET_MISSING

- **Package:** `@miujs/session`
- **HTTP status:** 500
- **Source:** [`session/src/index.ts`](../packages/session/src/index.ts)

**What it means:** No session secret configured

**How to fix:** Set the SESSION_SECRET environment variable (on Workers: `wrangler secret put SESSION_SECRET`) to a random string of 32+ characters, or pass session({ secret }).

## MIU_E_SESSION_SECRET_WEAK

- **Package:** `@miujs/session`
- **HTTP status:** 500
- **Source:** [`session/src/index.ts`](../packages/session/src/index.ts)

**What it means:** Session secret is shorter than {MIN_SECRET} characters

**How to fix:** Use a random secret of 32+ characters, e.g. the output of `openssl rand -base64 48`.

## MIU_E_SESSION_TABLE_INVALID

- **Package:** `@miujs/session`
- **HTTP status:** 500
- **Source:** [`session/src/stores.ts`](../packages/session/src/stores.ts)

**What it means:** Invalid table name "{table}"

**How to fix:** Use letters, digits and underscores.

## MIU_E_SESSION_TOO_LARGE

- **Package:** `@miujs/session`
- **HTTP status:** 500
- **Source:** [`session/src/index.ts`](../packages/session/src/index.ts)

**What it means:** Session cookie would be {value.length} bytes; browsers drop cookies over ~4 KB

**How to fix:** Store less in the session (ids, not records), or use a server store: session({ store: dbSessionStore(db) }) or kvSessionStore("SESSIONS").

## MIU_E_DB_BIND_UNDEFINED

- **Package:** `@miujs/db`
- **HTTP status:** 500
- **Source:** [`db/src/index.ts`](../packages/db/src/index.ts)

**What it means:** bind() value #{i} is undefined

**How to fix:** Pass null for SQL NULL; undefined is not a valid SQL value (D1 rejects it too).

## MIU_E_DB_BINDING_MISSING

- **Package:** `@miujs/db`
- **HTTP status:** 500
- **Source:** [`db/src/index.ts`](../packages/db/src/index.ts)

**What it means:** No D1 binding named "{name}" in env

**How to fix:** Add a [[d1_databases]] entry with binding = "{name}" to wrangler.toml (or run `miu deploy cloudflare`), or pass a database to db({ database }).

## MIU_E_DB_CLOSED

- **Package:** `@miujs/db`
- **HTTP status:** 500
- **Source:** [`db/src/index.ts`](../packages/db/src/index.ts)

**What it means:** sqlite("{path}") was closed

**How to fix:** Call close() only when you are done with the database, or open a new one with sqlite(path).

## MIU_E_DB_DRIZZLE_MISSING

- **Package:** `@miujs/db`
- **HTTP status:** 500
- **Source:** [`db/src/index.ts`](../packages/db/src/index.ts)

**What it means:** db({ drizzle }) could not load Drizzle: {err}

**How to fix:** Install drizzle-orm (bun add drizzle-orm) and add `import "@miujs/db/drizzle";` to your app entry (required when bundling, e.g. on Cloudflare Workers).

## MIU_E_DB_MIGRATION_DUPLICATE

- **Package:** `@miujs/db`
- **HTTP status:** 500
- **Source:** [`db/src/files.ts`](../packages/db/src/files.ts)

**What it means:** Two migrations in {where} share number {parsed}

**How to fix:** Renumber one of {parsed} and {parsed} so every number is unique (never renumber one already applied).

## MIU_E_DB_MIGRATION_FAILED

- **Package:** `@miujs/db`
- **HTTP status:** 500
- **Source:** [`db/src/index.ts`](../packages/db/src/index.ts)

**What it means:** Migration "{m.id}" failed: {err}

**How to fix:** Fix the migration SQL. It was rolled back; earlier migrations stay applied.

## MIU_E_DB_MIGRATION_INVALID

- **Package:** `@miujs/db`
- **HTTP status:** 500
- **Source:** [`db/src/files.ts`](../packages/db/src/files.ts)

**What it means:** Migration "{path}" is not text

**How to fix:** Pass the file contents as a string: import the .sql file as text (Wrangler: rules = [{ type = "Text", globs = ["**/*.sql"] }]; Bun: with { type: "text" }).

## MIU_E_DB_MIGRATION_NAME

- **Package:** `@miujs/db`
- **HTTP status:** 500
- **Source:** [`db/src/files.ts`](../packages/db/src/files.ts)

**What it means:** Migration file "{f.name}" in {where} has no number prefix

**How to fix:** Rename {f.name} to NNNN_name.sql (e.g. 0003_{f.name}), or move it out of the migrations folder.

## MIU_E_DB_MIGRATIONS_DIR

- **Package:** `@miujs/db`
- **HTTP status:** 500
- **Source:** [`db/src/files.ts`](../packages/db/src/files.ts)

**What it means:** Cannot read migrations directory {dir}: {err}

**How to fix:** Create {dir} (relative paths resolve from the working directory) or pass the right path to loadMigrations().

## MIU_E_DB_MISSING

- **Package:** `@miujs/db`
- **HTTP status:** 500
- **Source:** [`db/src/drizzle.ts`](../packages/db/src/drizzle.ts)

**What it means:** drizzle(ctx) needs ctx.db, but no database is set on this request

**How to fix:** Add db() from @miujs/db to miu({ plugins }), or call drizzleFor(database) with a database directly.

## MIU_E_DB_SCHEMA

- **Package:** `@miujs/db`
- **HTTP status:** 500
- **Source:** [`db/src/bridge.ts`](../packages/db/src/bridge.ts)

**What it means:**

- tableFromSchema("{name}"): {what} "{c}" is not a field of the schema
- tableFromSchema("{name}"): reference {field} → "{spec.table}" names another table by string
- tableFromSchema("{name}"): reference {field} has no table
- tableFromSchema("{name}"): reference {field} → {target}.{column} does not exist

**How to fix:**

- Use one of: {…}.
- Pass the table object instead, e.g. references: { {field}: { table: {spec.table}.table } }; only this table's own name ("{name}") works as a string (self reference).
- Pass a Drizzle table or a tableFromSchema() result as table.
- Use one of: {columns}.

## MIU_E_DB_UNSUPPORTED

- **Package:** `@miujs/db`
- **HTTP status:** 500
- **Source:** [`db/src/files.ts`](../packages/db/src/files.ts), [`db/src/index.ts`](../packages/db/src/index.ts)

**What it means:**

- loadMigrations() reads the filesystem, which {runtime} does not have
- sqlite() needs Bun (bun:sqlite); this is {runtime}

**How to fix:**

- Bundle the SQL as text and use migrationsFromGlob({ "0001_init.sql": sqlText, ... }) instead (e.g. import sql from "./migrations/0001_init.sql" with a text loader).
- On Cloudflare Workers use db({ database: d1("DB") }). Elsewhere, run with Bun or pass any D1-compatible database to db({ database }).

## MIU_E_CACHE_BINDING

- **Package:** `@miujs/cache`
- **HTTP status:** 500
- **Source:** [`cache/src/errors.ts`](../packages/cache/src/errors.ts)

**What it means:** KV binding {name} is not available in env

**How to fix:** Add a KV namespace binding named "{name}" to wrangler.toml ([[kv_namespaces]] binding = "{name}"), or pass a different name to kvStore().

## MIU_E_CACHE_CONFIG

- **Package:** `@miujs/cache`
- **HTTP status:** 500
- **Source:** [`cache/src/errors.ts`](../packages/cache/src/errors.ts), [`cache/src/memory.ts`](../packages/cache/src/memory.ts), [`cache/src/redis.ts`](../packages/cache/src/redis.ts)

**What it means:**

- memoryStore maxEntries must be a positive integer, got {maxEntries}
- redisStore needs a Redis client with get/set/del
- redisStore prefix must be a string, got {prefix}

**How to fix:**

- Pass `maxEntries` &gt;= 1, e.g. memoryStore({ maxEntries: 1000 }).
- Pass bunRedis() on Bun, or wrap another client with redisFromCommand(...).
- Pass a prefix such as "myapp:cache:", or "" for none.

## MIU_E_CACHE_KEY

- **Package:** `@miujs/cache`
- **HTTP status:** 500
- **Source:** [`cache/src/errors.ts`](../packages/cache/src/errors.ts)

**What it means:** Cache {what} must be a non-empty string, got {value}

**How to fix:** Pass a non-empty string {what}, e.g. `user:${id}`.

## MIU_E_CACHE_REDIS

- **Package:** `@miujs/cache`
- **HTTP status:** 500
- **Source:** [`cache/src/errors.ts`](../packages/cache/src/errors.ts)

**What it means:** Redis {op} for cache key {key} failed: {cause}

**How to fix:** Check that Redis is running and reachable at REDIS_URL (or the url passed to bunRedis()), and that the credentials and TLS settings are right.

## MIU_E_CACHE_REDIS_RUNTIME

- **Package:** `@miujs/cache`
- **HTTP status:** 500
- **Source:** [`cache/src/redis.ts`](../packages/cache/src/redis.ts)

**What it means:** bunRedis() needs Bun's built-in Redis client; this is {runtime}

**How to fix:** Run on Bun 1.2.9+, or pass any RedisLike client: wrap your Redis library with redisFromCommand((cmd, args) =&gt; client.sendCommand([cmd, ...args])). On Cloudflare Workers use kvStore / kvSessionStore / cloudflareQueue instead.

## MIU_E_CACHE_TTL

- **Package:** `@miujs/cache`
- **HTTP status:** 500
- **Source:** [`cache/src/errors.ts`](../packages/cache/src/errors.ts)

**What it means:** Cache ttl must be a positive number of seconds, got {ttl}

**How to fix:** Pass `ttl` in seconds (e.g. 60), or omit it to keep the entry until it is evicted or deleted.

## MIU_E_CACHE_VALUE

- **Package:** `@miujs/cache`
- **HTTP status:** 500
- **Source:** [`cache/src/errors.ts`](../packages/cache/src/errors.ts)

**What it means:** Cannot cache {key}: the value is not JSON-serializable

**How to fix:** Cache plain JSON data (objects, arrays, strings, numbers, booleans, null). Convert Dates to strings and BigInts to strings or numbers; `undefined` cannot be cached.

## MIU_E_QUEUE_BINDING

- **Package:** `@miujs/queue`
- **HTTP status:** 500
- **Source:** [`queue/src/errors.ts`](../packages/queue/src/errors.ts)

**What it means:** Queue binding {name} is not available in env

**How to fix:** Add a queue producer binding to wrangler.toml: [[queues.producers]] binding = "{name}" queue = "&lt;queue-name&gt;", plus a matching [[queues.consumers]] entry.

## MIU_E_QUEUE_CONFIG

- **Package:** `@miujs/queue`
- **HTTP status:** 500
- **Source:** [`queue/src/cloudflare.ts`](../packages/queue/src/cloudflare.ts), [`queue/src/durable.ts`](../packages/queue/src/durable.ts), [`queue/src/errors.ts`](../packages/queue/src/errors.ts), [`queue/src/job.ts`](../packages/queue/src/job.ts), [`queue/src/memory.ts`](../packages/queue/src/memory.ts), [`queue/src/plugin.ts`](../packages/queue/src/plugin.ts), [`queue/src/redis.ts`](../packages/queue/src/redis.ts), [`queue/src/sqlite.ts`](../packages/queue/src/sqlite.ts)

**What it means:**

- cloudflareQueue is not attached to a queue()
- This cloudflareQueue() is already used by another queue()
- {name} {label} must be a positive {integer}, got {v}
- {name}Queue is not attached to a queue()
- This {name}Queue() is already used by another queue()
- This {name} backend cannot cancel messages

**How to fix:**

- Pass it as `queue({ adapter: cloudflareQueue() })`.
- Create one cloudflareQueue() per queue() plugin.
- Pass `{label}: {example}`.
- Pass it as `queue({ adapter: {name}Queue(...) })`.
- Create one {name}Queue() per queue() plugin.
- Implement cancel(id) in the DurableBackend.

## MIU_E_QUEUE_CRON

- **Package:** `@miujs/queue`
- **HTTP status:** 500
- **Source:** [`queue/src/errors.ts`](../packages/queue/src/errors.ts)

**What it means:** Invalid cron expression {expr}: {problem}

**How to fix:** Use 5 fields "minute hour day-of-month month day-of-week" with *, numbers, a-b ranges, a,b lists and /n steps, e.g. "*/5 * * * *". Times are UTC.

## MIU_E_QUEUE_DELAY

- **Package:** `@miujs/queue`
- **HTTP status:** 500
- **Source:** [`queue/src/errors.ts`](../packages/queue/src/errors.ts)

**What it means:** Job delay must be between 0 and {max} seconds, got {delay}

**How to fix:** Pass { delay } in seconds, at most {max}. For longer waits, use a schedule or store the job and dispatch it later.

## MIU_E_QUEUE_JOB_DUPLICATE

- **Package:** `@miujs/queue`
- **HTTP status:** 500
- **Source:** [`queue/src/errors.ts`](../packages/queue/src/errors.ts)

**What it means:** Two jobs are named "{job}"

**How to fix:** Give each defineJob() a unique name.

## MIU_E_QUEUE_REDIS

- **Package:** `@miujs/queue`
- **HTTP status:** 500
- **Source:** [`queue/src/errors.ts`](../packages/queue/src/errors.ts), [`queue/src/redis.ts`](../packages/queue/src/redis.ts)

**What it means:** Queue {code} operation "{op}" failed: {cause}

**How to fix:** Read the message and `details` in the error body, then the source linked above.

## MIU_E_QUEUE_RUNTIME

- **Package:** `@miujs/queue`
- **HTTP status:** 500
- **Source:** [`queue/src/errors.ts`](../packages/queue/src/errors.ts), [`queue/src/sqlite.ts`](../packages/queue/src/sqlite.ts)

**What it means:** {what} is not available on {runtime}

**How to fix:**

- sqliteQueue needs Bun. On Node or Deno use redisQueue(...) or memoryQueue(); on Cloudflare Workers use cloudflareQueue().
- sqliteQueue needs Bun. Use redisQueue(...) or memoryQueue() elsewhere.

## MIU_E_QUEUE_SQLITE

- **Package:** `@miujs/queue`
- **HTTP status:** 500
- **Source:** [`queue/src/errors.ts`](../packages/queue/src/errors.ts), [`queue/src/sqlite.ts`](../packages/queue/src/sqlite.ts)

**What it means:** Queue {code} operation "{op}" failed: {cause}

**How to fix:** Read the message and `details` in the error body, then the source linked above.

## MIU_E_QUEUE_TIMEOUT

- **Package:** `@miujs/queue`
- **HTTP status:** 500
- **Source:** [`queue/src/errors.ts`](../packages/queue/src/errors.ts)

**What it means:** Job "{job}" did not finish within its {seconds}s lease and has no attempts left

**How to fix:** Its worker stopped (crash, deploy, scaled down) or stalled. Make the job idempotent and give it `retries`, or raise `visibilityTimeout` if a single run legitimately blocks the event loop that long.

## MIU_E_QUEUE_UNKNOWN_JOB

- **Package:** `@miujs/queue`
- **HTTP status:** 500
- **Source:** [`queue/src/errors.ts`](../packages/queue/src/errors.ts)

**What it means:** Job "{job}" is not registered with this queue

**How to fix:** Add it to queue({ jobs: [...] }). Registered jobs: {known.length}.

## MIU_E_RATELIMIT_BINDING

- **Package:** `@miujs/ratelimit`
- **HTTP status:** 500
- **Source:** [`ratelimit/src/stores.ts`](../packages/ratelimit/src/stores.ts)

**What it means:** Rate limit {what} binding "{binding}" is not configured

**How to fix:**

- Add a KV namespace binding named {binding} to wrangler.toml (miu deploy cloudflare does this), or use memoryStore() locally.
- Add a durable_objects binding named {binding} with class_name "RateLimiterDurableObject" (miu deploy cloudflare does this) and export the class: export { RateLimiterDurableObject } from "@miujs/ratelimit".
- Add [[ratelimits]] name = "{binding}" with simple = { limit = {opts.limit}, period = {opts.period} } to wrangler.toml (miu deploy cloudflare does this).

## MIU_E_RATELIMIT_CONFIG

- **Package:** `@miujs/ratelimit`
- **HTTP status:** 500
- **Source:** [`ratelimit/src/algorithms.ts`](../packages/ratelimit/src/algorithms.ts), [`ratelimit/src/plugin.ts`](../packages/ratelimit/src/plugin.ts), [`ratelimit/src/stores.ts`](../packages/ratelimit/src/stores.ts)

**What it means:**

- Invalid rate limit window {w}
- {where}: limit must be a positive integer
- {where}: unknown algorithm {p.algorithm}
- {where}: burst must be a positive integer
- {where}: burst only applies to the token bucket
- {where}: cost must be an integer from 1 to {cap}

**How to fix:**

- Use a positive number of seconds or a string like "10s", "1m", "15m", "1h" or "1d".
- Set limit to the number of requests allowed per window, e.g. limit: 100.
- Use algorithm: "fixed", "sliding" (default) or "token-bucket".
- Set burst to the bucket capacity, e.g. burst: 20.
- Remove burst, or set algorithm: "token-bucket".
- A hit can never cost more than the limit (or burst).

## MIU_E_RATELIMIT_ORDER

- **Package:** `@miujs/ratelimit`
- **HTTP status:** 500
- **Source:** [`ratelimit/src/plugin.ts`](../packages/ratelimit/src/plugin.ts)

**What it means:** rateLimit() runs before auth(), so by: "user" would never see a user

**How to fix:** List auth() before rateLimit() in miu({ plugins }).

## MIU_E_RATELIMIT_STORE

- **Package:** `@miujs/ratelimit`
- **HTTP status:** 503
- **Source:** [`ratelimit/src/plugin.ts`](../packages/ratelimit/src/plugin.ts)

**What it means:** Rate limiting is unavailable

**How to fix:** Check the {store.kind} rate limit store (binding, network, credentials), or set rateLimit({ onStoreError: "allow" }) to fail open.

## MIU_E_RATELIMIT_UNSUPPORTED

- **Package:** `@miujs/ratelimit`
- **HTTP status:** 500
- **Source:** [`ratelimit/src/plugin.ts`](../packages/ratelimit/src/plugin.ts), [`ratelimit/src/stores.ts`](../packages/ratelimit/src/stores.ts)

**What it means:**

- {store.kind} store cannot reset keys
- redisStore().reset needs the policy and a client with del
- {where}: {store.kind} store cannot enforce this rule: {why}

**How to fix:**

- Wait for the window to pass, or use a store with reset().
- Call limiter.reset(key) (it passes the policy), and give redisStore a client with del(...keys).
- Change the rule, or use a store that supports it (memoryStore() or durableObjectStore() support every algorithm).

## MIU_E_ROOM_ALREADY_JOINED

- **Package:** `@miujs/realtime`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`realtime/src/room.ts`](../packages/realtime/src/room.ts)

**What it means:** This connection already joined

**How to fix:** Send `msg` frames; open a new connection to join as someone else.

## MIU_E_ROOM_BAD_FRAME

- **Package:** `@miujs/realtime`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`realtime/src/room.ts`](../packages/realtime/src/room.ts)

**What it means:**

- Binary frames need the MessagePack encoding
- Frame is not valid MessagePack
- Frame is not valid JSON
- Frame must be an object with a string `t`
- Unknown frame type "{f.t}"

**How to fix:**

- Send JSON text frames, or connect with ?enc=msgpack to use binary MessagePack frames. See PROTOCOL.md.
- Send one MessagePack map per binary frame, e.g. {t: "ping"}.
- Send one JSON object per frame, e.g. {"t":"ping"}.
- Use one of: join, msg, ping. See PROTOCOL.md.
- Clients send join, msg or ping frames. See PROTOCOL.md.

## MIU_E_ROOM_CLIENT_NOT_FOUND

- **Package:** `@miujs/realtime`
- **HTTP status:** 404
- **Source:** [`realtime/src/plugin.ts`](../packages/realtime/src/plugin.ts)

**What it means:** No such client build

**How to fix:** Load {clientPath} (rooms plugin .clientPath) or {prefix}/_client.js.

## MIU_E_ROOM_CLOSED

- **Package:** `@miujs/realtime`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`realtime/src/room.ts`](../packages/realtime/src/room.ts)

**What it means:** This room has been closed

**How to fix:** Join or create another room.

## MIU_E_ROOM_CODE_RATE_LIMITED

- **Package:** `@miujs/realtime`
- **HTTP status:** 429
- **Source:** [`realtime/src/plugin.ts`](../packages/realtime/src/plugin.ts)

**What it means:** Too many join-code lookups

**How to fix:** Wait a few seconds; at most {perMinute} lookups per minute are allowed per IP.

## MIU_E_ROOM_CODE_UNKNOWN

- **Package:** `@miujs/realtime`
- **HTTP status:** 404
- **Source:** [`realtime/src/plugin.ts`](../packages/realtime/src/plugin.ts)

**What it means:** No room with code {code}

**How to fix:** Check the 6-digit code; codes expire a few hours after the room was created.

## MIU_E_ROOM_CODES_EXHAUSTED

- **Package:** `@miujs/realtime`
- **HTTP status:** 503
- **Source:** [`realtime/src/codes.ts`](../packages/realtime/src/codes.ts)

**What it means:** Could not find a free join code after {attempts} tries

**How to fix:** Too many live codes: lower codeTtlMs in rooms({ ... }) so old codes expire sooner, or join rooms by id.

## MIU_E_ROOM_CREATE_FAILED

- **Package:** `@miujs/realtime`
- **HTTP status:** 502
- **Source:** [`realtime/src/plugin.ts`](../packages/realtime/src/plugin.ts)

**What it means:** The Durable Object for {type}:{id} answered {res.status}

**How to fix:** Pass the same rooms to createRoomDurableObject() and rooms({ rooms }).

## MIU_E_ROOM_ENCODING_UNSUPPORTED

- **Package:** `@miujs/realtime`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`realtime/src/room.ts`](../packages/realtime/src/room.ts)

**What it means:** Unknown encoding "{enc}"

**How to fix:** Use ?enc=json (default) or ?enc=msgpack.

## MIU_E_ROOM_FULL

- **Package:** `@miujs/realtime`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`realtime/src/room.ts`](../packages/realtime/src/room.ts)

**What it means:** Room is full ({max} players)

**How to fix:** Join another room, or join as a spectator.

## MIU_E_ROOM_HANDLER_FAILED

- **Package:** `@miujs/realtime`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`realtime/src/room.ts`](../packages/realtime/src/room.ts)

**What it means:** The {where} handler failed: {err}

**How to fix:** Check the server log; state was rolled back.

## MIU_E_ROOM_HANDLER_UNKNOWN

- **Package:** `@miujs/realtime`
- **HTTP status:** 500
- **Source:** [`realtime/src/define.ts`](../packages/realtime/src/define.ts)

**What it means:** Room "{type}" has a handler on.{k} but no client.{k} schema

**How to fix:** Add {k}: t.object({...}) to `client`, or remove on.{k}.

## MIU_E_ROOM_HOST_KEY

- **Package:** `@miujs/realtime`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`realtime/src/room.ts`](../packages/realtime/src/room.ts)

**What it means:** This room already has a host

**How to fix:** Join as a player, or pass the hostKey from the host's welcome frame (?hostKey=...).

## MIU_E_ROOM_ID_INVALID

- **Package:** `@miujs/realtime`
- **HTTP status:** 400
- **Source:** [`realtime/src/cloudflare.ts`](../packages/realtime/src/cloudflare.ts), [`realtime/src/plugin.ts`](../packages/realtime/src/plugin.ts)

**What it means:**

- Invalid room id
- Room id must be 1-64 letters, digits, '_' or '-'

**How to fix:**

- Use 1-64 letters, digits, '_' or '-'.
- Use the id from createRoom(), or a short code such as one from rooms.createCode().

## MIU_E_ROOM_JOIN_INVALID

- **Package:** `@miujs/realtime`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`realtime/src/room.ts`](../packages/realtime/src/room.ts)

**What it means:**

- Join needs a name of 1-{NAME_MAX} characters
- Unknown role "{requested}"

**How to fix:**

- Connect with ?name=Alice or send {"t":"join","name":"Alice"}.
- Use role host, player or spectator (or leave it out).

## MIU_E_ROOM_JOIN_REJECTED

- **Package:** `@miujs/realtime`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`realtime/src/room.ts`](../packages/realtime/src/room.ts)

**What it means:** The room refused this join

**How to fix:** Check the server log.

## MIU_E_ROOM_KICKED

- **Package:** `@miujs/realtime`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`realtime/src/room.ts`](../packages/realtime/src/room.ts)

**What it means:** You were removed from the room

**How to fix:** Join another room; this seat and its resume token are gone.

## MIU_E_ROOM_MESSAGE_INVALID

- **Package:** `@miujs/realtime`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`realtime/src/room.ts`](../packages/realtime/src/room.ts)

**What it means:** Invalid "{type}" message: {i}

**How to fix:** Send data matching the "{type}" schema.

## MIU_E_ROOM_MESSAGE_TOO_LARGE

- **Package:** `@miujs/realtime`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`realtime/src/room.ts`](../packages/realtime/src/room.ts)

**What it means:** Frame is larger than {max} bytes

**How to fix:** Keep each frame under {max} bytes; send big data over HTTP instead.

## MIU_E_ROOM_NOT_FOUND

- **Package:** `@miujs/realtime`
- **HTTP status:** 404
- **Source:** [`realtime/src/cloudflare.ts`](../packages/realtime/src/cloudflare.ts), [`realtime/src/plugin.ts`](../packages/realtime/src/plugin.ts)

**What it means:**

- No active room here
- No active room {type}/{id}

**How to fix:**

- Join the room first.
- Call rooms_list to see active rooms.

## MIU_E_ROOM_NOT_JOINED

- **Package:** `@miujs/realtime`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`realtime/src/room.ts`](../packages/realtime/src/room.ts)

**What it means:** Join the room before sending messages

**How to fix:** Connect with ?name=... or send {"t":"join","name":"..."} first.

## MIU_E_ROOM_RATE_LIMITED

- **Package:** `@miujs/realtime`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`realtime/src/room.ts`](../packages/realtime/src/room.ts)

**What it means:** Too many messages; this one was dropped

**How to fix:** Send at most {perSecond} messages per second (bursts up to {burst}). Batch inputs or throttle the client.

## MIU_E_ROOM_REACT_MISSING

- **Package:** `@miujs/realtime`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`realtime/src/react.ts`](../packages/realtime/src/react.ts)

**What it means:** See the source; this code has no static message.

**How to fix:** Pass it: useRoom(url, { name, react: React }), or bind once: const useRoom = createUseRoom(React) (import * as React from "react").

## MIU_E_ROOM_RESUME_EXPIRED

- **Package:** `@miujs/realtime`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`realtime/src/room.ts`](../packages/realtime/src/room.ts)

**What it means:** Resume token is unknown or expired

**How to fix:** Join again as a new player: send {"t":"join","name":"..."}.

## MIU_E_ROOM_SHARD_SIZE

- **Package:** `@miujs/realtime`
- **HTTP status:** 500
- **Source:** [`realtime/src/shard.ts`](../packages/realtime/src/shard.ts)

**What it means:**

- shardedRoom("{room.type}") needs a positive integer shardSize
- Room "{room.type}" has maxPlayers {room.def.maxPlayers}, smaller than shardSize {opts.shardSize}

**How to fix:**

- Pass e.g. shardedRoom(room, { shardSize: 100 }).
- Remove maxPlayers from the room or lower shardSize.

## MIU_E_ROOM_STATE_INVALID

- **Package:** `@miujs/realtime`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`realtime/src/room.ts`](../packages/realtime/src/room.ts)

**What it means:** The {where} handler left state that does not match the schema: {issues}

**How to fix:** Fix the handler or the room's state schema; the change was rolled back.

## MIU_E_ROOM_TIMER_NOT_DURABLE

- **Package:** `@miujs/realtime`
- **HTTP status:** 500
- **Source:** [`realtime/src/room.ts`](../packages/realtime/src/room.ts)

**What it means:** room.{what}() closures cannot survive Durable Object hibernation

**How to fix:** Declare a named timer and call room.schedule(name, delayMs, data): defineRoom("{this.type}", { timers: { reveal: ({ room, data }) =&gt; { ... } } }). For a loop, re-schedule from inside the handler.

## MIU_E_ROOM_TIMER_UNKNOWN

- **Package:** `@miujs/realtime`
- **HTTP status:** 500
- **Source:** [`realtime/src/room.ts`](../packages/realtime/src/room.ts)

**What it means:** Room "{this.type}" has no timer handler "{name}"

**How to fix:** Use one of: {…}, or add {name} to defineRoom({ timers: { ... } }). (otherwise: Declare it: defineRoom("{this.type}", { timers: { {name}: ({ room, data }) =&gt; { ... } } }).)

## MIU_E_ROOM_TYPE_INVALID

- **Package:** `@miujs/realtime`
- **HTTP status:** 500
- **Source:** [`realtime/src/define.ts`](../packages/realtime/src/define.ts)

**What it means:** Room type "{type}" is not a valid name

**How to fix:** Use 1-64 letters, digits, '_' or '-', e.g. defineRoom("quiz", ...).

## MIU_E_ROOM_TYPE_UNKNOWN

- **Package:** `@miujs/realtime`
- **HTTP status:** 404
- **Source:** [`realtime/src/cloudflare.ts`](../packages/realtime/src/cloudflare.ts), [`realtime/src/plugin.ts`](../packages/realtime/src/plugin.ts)

**What it means:** No room type "{type}"

**How to fix:**

- Use one of: {…}, and pass the same rooms to createRoomDurableObject().
- Use one of: {…}, or add the room to rooms({ rooms: [...] }).

## MIU_E_ROOM_UNKNOWN_MESSAGE

- **Package:** `@miujs/realtime`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`realtime/src/room.ts`](../packages/realtime/src/room.ts)

**What it means:** Room "{this.type}" has no message type {type}

**How to fix:** Use one of: {…}. (otherwise: This room accepts no client messages.)

## MIU_E_FILES_BAD_FORM

- **Package:** `@miujs/files`
- **HTTP status:** 400
- **Source:** [`files/src/upload.ts`](../packages/files/src/upload.ts)

**What it means:** The multipart/form-data body could not be parsed

**How to fix:** Send a well-formed multipart/form-data body (let the browser or fetch build it from a FormData).

## MIU_E_FILES_BAD_REQUEST

- **Package:** `@miujs/files`
- **HTTP status:** 400
- **Source:** [`files/src/multipart.ts`](../packages/files/src/multipart.ts)

**What it means:**

- Request body must be a JSON object
- filename must be a string
- contentType must be a media type string

**How to fix:**

- Send JSON such as { "filename": "tour.glb", "contentType": "model/gltf-binary" }.
- Send e.g. { "filename": "tour.glb" }.
- Send e.g. { "contentType": "model/gltf-binary" }.

## MIU_E_FILES_BINDING

- **Package:** `@miujs/files`
- **HTTP status:** 500
- **Source:** [`files/src/errors.ts`](../packages/files/src/errors.ts)

**What it means:** R2 binding {name} is not available in env

**How to fix:** Add an R2 bucket binding named "{name}" to wrangler.toml ([[r2_buckets]] binding = "{name}" bucket_name = "..."), or pass a different name to r2Store().

## MIU_E_FILES_BODY_USED

- **Package:** `@miujs/files`
- **HTTP status:** 500
- **Source:** [`files/src/upload.ts`](../packages/files/src/upload.ts)

**What it means:** The request body was already read before handleUpload

**How to fix:** Remove the `body` schema from this route (and don't read ctx.req yourself): handleUpload streams the raw body.

## MIU_E_FILES_CONFIG

- **Package:** `@miujs/files`
- **HTTP status:** 500
- **Source:** [`files/src/client.ts`](../packages/files/src/client.ts), [`files/src/local.ts`](../packages/files/src/local.ts), [`files/src/multipart.ts`](../packages/files/src/multipart.ts), [`files/src/plugin.ts`](../packages/files/src/plugin.ts), [`files/src/sniff.ts`](../packages/files/src/sniff.ts), [`files/src/upload.ts`](../packages/files/src/upload.ts)

**What it means:**

- localStore needs a directory
- Invalid basePath {p}
- maxUploadSize must be a positive number of bytes
- allowedTypes must list at least one type
- allowedTypes contains {raw}, which cannot be detected from file contents
- Invalid contentType {t}

**How to fix:**

- Pass a directory, e.g. localStore("./data/files").
- Use an absolute path without a trailing slash or params, e.g. "/_files" or "/media".
- Pass e.g. maxUploadSize: 50 * 1024 * 1024.
- Pass allowedTypes such as ["png", "jpeg", "webp"]. Known: {KNOWN_TYPES}.
- Use only: {KNOWN_TYPES} (or their mime types).
- Pass a media type such as "image/png" (no line breaks, max 255 chars).

## MIU_E_FILES_KEY_CONFLICT

- **Package:** `@miujs/files`
- **HTTP status:** 409
- **Source:** [`files/src/local.ts`](../packages/files/src/local.ts)

**What it means:** Key {key} collides with an existing file or folder on disk

**How to fix:** On the local store a key cannot be both a file and a "folder" prefix of other keys (e.g. "a" and "a/b"). Use distinct keys such as "a/index".

## MIU_E_FILES_KEY_INVALID

- **Package:** `@miujs/files`
- **HTTP status:** 400
- **Source:** [`files/src/errors.ts`](../packages/files/src/errors.ts)

**What it means:** Invalid file key {key}: {why}

**How to fix:** Use a relative key of '/'-separated segments such as `avatars/${userId}.png`: no leading '/', no '.' or '..' segments, no empty segments, no backslashes, control characters or ':' (max 1024 bytes).

## MIU_E_FILES_METADATA_INVALID

- **Package:** `@miujs/files`
- **HTTP status:** 400
- **Source:** [`files/src/s3.ts`](../packages/files/src/s3.ts)

**What it means:** S3 metadata {k} must have a [A-Za-z0-9_-] name and a printable ASCII value

**How to fix:** Use simple ASCII metadata (encode other text yourself, e.g. with encodeURIComponent). S3 also lowercases metadata names.

## MIU_E_FILES_NO_FILE

- **Package:** `@miujs/files`
- **HTTP status:** 400
- **Source:** [`files/src/upload.ts`](../packages/files/src/upload.ts)

**What it means:** No file in the request (field "{field}")

**How to fix:** Send multipart/form-data with the file in the "{field}" field, or the raw file bytes as the body.

## MIU_E_FILES_NOT_FOUND

- **Package:** `@miujs/files`
- **HTTP status:** 404
- **Source:** [`files/src/errors.ts`](../packages/files/src/errors.ts)

**What it means:** File {key} not found

**How to fix:** Check the key, or upload the file first with ctx.files.put().

## MIU_E_FILES_PART_INVALID

- **Package:** `@miujs/files`
- **HTTP status:** 400
- **Source:** [`files/src/errors.ts`](../packages/files/src/errors.ts)

**What it means:** Part {partNumber} is missing or its etag does not match

**How to fix:** Send `parts` as the { partNumber, etag } pairs returned by each part upload, in order. Re-upload any part that failed.

## MIU_E_FILES_RUNTIME

- **Package:** `@miujs/files`
- **HTTP status:** 500
- **Source:** [`files/src/errors.ts`](../packages/files/src/errors.ts)

**What it means:** {what} is not available on {runtime}

**How to fix:** localStore needs Bun or Node file-system access. On Cloudflare Workers use r2Store("FILES"); elsewhere use memoryStore() or a custom store.

## MIU_E_FILES_S3

- **Package:** `@miujs/files`
- **HTTP status:** 502
- **Source:** [`files/src/s3.ts`](../packages/files/src/s3.ts)

**What it means:**

- S3 {op} failed: {status} {code}{message}
- S3 {op} could not reach {r.endpoint.origin}: {err}

**How to fix:** Check S3_ENDPOINT (or endpoint) and that the service is reachable from here.

## MIU_E_FILES_S3_CONFIG

- **Package:** `@miujs/files`
- **HTTP status:** 500
- **Source:** [`files/src/s3.ts`](../packages/files/src/s3.ts)

**What it means:**

- s3Store is missing {…}
- s3Store endpoint {endpointText} is not an http(s) URL

**How to fix:**

- Set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (plus S3_ENDPOINT and S3_REGION for non-AWS services), or pass them to s3Store({ ... }), as values or as { env: "VAR_NAME" }. On Workers: `wrangler secret put S3_SECRET_ACCESS_KEY`.
- Pass an endpoint such as "https://s3.eu-central-1.amazonaws.com" or "https://&lt;account&gt;.r2.cloudflarestorage.com".

## MIU_E_FILES_SECRET_MISSING

- **Package:** `@miujs/files`
- **HTTP status:** 500
- **Source:** [`files/src/errors.ts`](../packages/files/src/errors.ts)

**What it means:** No secret configured for signing file URLs

**How to fix:** Set FILES_SECRET (or SESSION_SECRET) to a random string of 32+ characters (on Workers: `wrangler secret put FILES_SECRET`), or pass files({ secret }).

## MIU_E_FILES_SECRET_WEAK

- **Package:** `@miujs/files`
- **HTTP status:** 500
- **Source:** [`files/src/errors.ts`](../packages/files/src/errors.ts)

**What it means:** The file-signing secret is shorter than 32 characters

**How to fix:** Use a random secret of 32+ characters, e.g. the output of `openssl rand -base64 48`.

## MIU_E_FILES_STORE_MISSING

- **Package:** `@miujs/files`
- **HTTP status:** 500
- **Source:** [`files/src/errors.ts`](../packages/files/src/errors.ts)

**What it means:** files() has no store configured in production

**How to fix:** Pass a store: files({ store: r2Store("FILES") }) on Workers or files({ store: localStore("./data/files") }) on a server. The in-memory default is for development only.

## MIU_E_FILES_TOKEN_EXPIRED

- **Package:** `@miujs/files`
- **HTTP status:** 403
- **Source:** [`files/src/errors.ts`](../packages/files/src/errors.ts)

**What it means:** This file URL has expired

**How to fix:** Request a fresh URL from the server, or sign it with a longer `expiresIn`.

## MIU_E_FILES_TOKEN_INVALID

- **Package:** `@miujs/files`
- **HTTP status:** 403
- **Source:** [`files/src/errors.ts`](../packages/files/src/errors.ts)

**What it means:** Invalid file token: {why}

**How to fix:** Request a fresh URL from the server (ctx.files.signedUrl). Signed URLs cannot be edited, and only work for the method they were signed for.

## MIU_E_FILES_TOO_LARGE

- **Package:** `@miujs/files`
- **HTTP status:** 413
- **Source:** [`files/src/errors.ts`](../packages/files/src/errors.ts)

**What it means:** File is larger than the {limit}-byte limit

**How to fix:** Send at most {limit} bytes, or raise `maxSize` on the server. Large 3D/360° assets should use the resumable multipart upload routes.

## MIU_E_FILES_TOO_MANY_FILES

- **Package:** `@miujs/files`
- **HTTP status:** 400
- **Source:** [`files/src/upload.ts`](../packages/files/src/upload.ts)

**What it means:** Got {list.length} files, at most {maxFiles} allowed

**How to fix:** Send at most {maxFiles} file(s) per request.

## MIU_E_FILES_TYPE_NOT_ALLOWED

- **Package:** `@miujs/files`
- **HTTP status:** 415
- **Source:** [`files/src/errors.ts`](../packages/files/src/errors.ts)

**What it means:** File type {got} is not allowed (otherwise: File type could not be recognized from its contents)

**How to fix:** Upload one of: {…}. The type is detected from the file's bytes, not its name or the client's content-type.

## MIU_E_FILES_UPLOAD_NOT_FOUND

- **Package:** `@miujs/files`
- **HTTP status:** 404
- **Source:** [`files/src/errors.ts`](../packages/files/src/errors.ts)

**What it means:** Multipart upload not found (completed, aborted or expired)

**How to fix:** Start a new upload with POST {basePath}/uploads.

## MIU_E_WEB_BAD_PATH

- **Package:** `@miujs/web`
- **HTTP status:** 400
- **Source:** [`web/src/errors.ts`](../packages/web/src/errors.ts)

**What it means:** Refused to serve {…}: the path is malformed or tries to leave the static directory

**How to fix:** Request files by their plain URL path, e.g. /assets/app.js. `..`, backslashes, `:` and NUL bytes are not allowed.

## MIU_E_WEB_CONFIG

- **Package:** `@miujs/web`
- **HTTP status:** 500
- **Source:** [`web/src/errors.ts`](../packages/web/src/errors.ts), [`web/src/htmx.ts`](../packages/web/src/htmx.ts), [`web/src/secure.ts`](../packages/web/src/secure.ts), [`web/src/static.ts`](../packages/web/src/static.ts), [`web/src/vite.ts`](../packages/web/src/vite.ts)

**What it means:**

- Invalid htmx event name {event}
- Invalid {where} value {v}
- Invalid CSP directive name {rawName}
- Set frame-ancestors with the `frameAncestors` option
- Invalid Permissions-Policy feature {feature}
- ctx.state.frameAncestors must be a non-empty array of sources

**How to fix:**

- Use a plain ASCII event name such as `saved` or `cart:updated`.
- Pass one source per array item, e.g. ["'self'", "https://listings.example.com"]. Values cannot contain spaces, ";" or ",".
- Use directive names such as scriptSrc or "script-src".
- Move it: secureHeaders({ frameAncestors: [...], csp: {...} }). It also controls X-Frame-Options.
- Use feature names such as camera or xr-spatial-tracking.
- Set e.g. ctx.state.frameAncestors = ["https://listings.example.com"].

## MIU_E_WEB_HTML_ASYNC

- **Package:** `@miujs/web`
- **HTTP status:** 500
- **Source:** [`web/src/errors.ts`](../packages/web/src/errors.ts)

**What it means:** A Promise was interpolated into an html`` template or JSX

**How to fix:** Await the value before rendering: `const user = await getUser(); html`&lt;p&gt;${user.name}&lt;/p&gt;``. Templates render synchronously.

## MIU_E_WEB_HTML_FUNCTION

- **Package:** `@miujs/web`
- **HTTP status:** 500
- **Source:** [`web/src/errors.ts`](../packages/web/src/errors.ts)

**What it means:** A function was interpolated into an html`` template or JSX children

**How to fix:** Call the component instead of passing it: `${Layout(props)}` (or `<Layout />` in JSX).

## MIU_E_WEB_HTML_RAW

- **Package:** `@miujs/web`
- **HTTP status:** 500
- **Source:** [`web/src/errors.ts`](../packages/web/src/errors.ts)

**What it means:** raw() expects a string, got {value}

**How to fix:** Pass a string you trust to raw(), e.g. raw(markdownToHtml(src)). Never pass user input.

## MIU_E_WEB_HX_URL

- **Package:** `@miujs/web`
- **HTTP status:** 500
- **Source:** [`web/src/errors.ts`](../packages/web/src/errors.ts)

**What it means:** Refused to redirect htmx to {…}

**How to fix:** Pass a path (`/dashboard`) or an http(s) URL. Other schemes such as javascript: are rejected.

## MIU_E_WEB_JSX_ATTR

- **Package:** `@miujs/web`
- **HTTP status:** 500
- **Source:** [`web/src/errors.ts`](../packages/web/src/errors.ts)

**What it means:** Invalid attribute name {name}

**How to fix:** Attribute names may contain letters, digits, `-`, `_`, `.`, `:` and `@` only. Never build attribute names from user input.

## MIU_E_WEB_JSX_EVENT_HANDLER

- **Package:** `@miujs/web`
- **HTTP status:** 500
- **Source:** [`web/src/errors.ts`](../packages/web/src/errors.ts)

**What it means:** Inline event handler attribute "{name}" is not allowed

**How to fix:** Server-rendered JSX cannot attach functions and inline handlers defeat CSP. Add a listener in a script (`<script nonce={nonce(ctx)}>el.addEventListener("{…}", …)</script>`) or use htmx attributes (hx-post, hx-trigger).

## MIU_E_WEB_JSX_INNER_HTML

- **Package:** `@miujs/web`
- **HTTP status:** 500
- **Source:** [`web/src/errors.ts`](../packages/web/src/errors.ts)

**What it means:** dangerouslySetInnerHTML must be { __html: string } and cannot be combined with children

**How to fix:** Pass `dangerouslySetInnerHTML={{ __html: trustedString }}` and no children.

## MIU_E_WEB_JSX_TAG

- **Package:** `@miujs/web`
- **HTTP status:** 500
- **Source:** [`web/src/errors.ts`](../packages/web/src/errors.ts)

**What it means:** Invalid JSX element name {tag}

**How to fix:** Use a lowercase HTML tag (`div`), a custom element with a dash (`model-viewer`), or a component function.

## MIU_E_WEB_JSX_VOID_CHILDREN

- **Package:** `@miujs/web`
- **HTTP status:** 500
- **Source:** [`web/src/errors.ts`](../packages/web/src/errors.ts)

**What it means:** &lt;{tag}&gt; is a void element and cannot have children

**How to fix:** Remove the children of &lt;{tag} /&gt;.

## MIU_E_WEB_NO_NONCE

- **Package:** `@miujs/web`
- **HTTP status:** 500
- **Source:** [`web/src/errors.ts`](../packages/web/src/errors.ts)

**What it means:** No CSP nonce on this request

**How to fix:** Enable a Content-Security-Policy with a nonce: `secureHeaders({ csp: true })` (or `csp: { ...directives }`) in `miu({ plugins })`.

## MIU_E_WEB_VITE_DEV_UNREACHABLE

- **Package:** `@miujs/web`
- **HTTP status:** 502
- **Source:** [`web/src/errors.ts`](../packages/web/src/errors.ts)

**What it means:** Vite dev server at {url} did not respond

**How to fix:** Start it with `bunx vite` (or `bun run dev` in the frontend folder), or fix the `dev` URL passed to vite().

## MIU_E_WEB_VITE_ENTRY

- **Package:** `@miujs/web`
- **HTTP status:** 500
- **Source:** [`web/src/errors.ts`](../packages/web/src/errors.ts)

**What it means:** Vite manifest has no entry {entry}

**How to fix:** Use the entry's source path relative to the Vite root, as in build.rollupOptions.input. Known entries: {none}.

## MIU_E_WEB_VITE_MANIFEST

- **Package:** `@miujs/web`
- **HTTP status:** 500
- **Source:** [`web/src/errors.ts`](../packages/web/src/errors.ts)

**What it means:** Vite manifest {path} could not be read

**How to fix:** Run `vite build` with `build.manifest: true` in vite.config, or pass the manifest object: `vite({ manifest: manifestJson })` (required on Workers).

## MIU_E_MAIL_ADDRESS_INVALID

- **Package:** `@miujs/mail`
- **HTTP status:** 400
- **Source:** [`mail/src/mailer.ts`](../packages/mail/src/mailer.ts), [`mail/src/message.ts`](../packages/mail/src/message.ts)

**What it means:**

- Email has no recipients
- Invalid email address in {field}: {value}

**How to fix:**

- Pass at least one address in `to`.
- Use a single address like "ann@example.com" or "Ann &lt;ann@example.com&gt;" per entry; pass several recipients as an array.

## MIU_E_MAIL_API_KEY_MISSING

- **Package:** `@miujs/mail`
- **HTTP status:** 500
- **Source:** [`mail/src/transports.ts`](../packages/mail/src/transports.ts)

**What it means:** No Resend API key (looked for {envName})

**How to fix:** Set the {envName} environment variable (on Workers: `wrangler secret put {envName}`), or pass resendTransport({ apiKey }).

## MIU_E_MAIL_CONTENT_MISSING

- **Package:** `@miujs/mail`
- **HTTP status:** 500
- **Source:** [`mail/src/mailer.ts`](../packages/mail/src/mailer.ts)

**What it means:** Email has no {what}

**How to fix:** Pass `subject` and `html` or `text`, or a `template` that returns them.

## MIU_E_MAIL_HEADER_INVALID

- **Package:** `@miujs/mail`
- **HTTP status:** 400
- **Source:** [`mail/src/message.ts`](../packages/mail/src/message.ts)

**What it means:**

- The subject contains a line break (possible header injection)
- The subject is longer than 998 characters
- Invalid header name {…}
- The {name} header cannot be set through `headers`
- The {name} header value contains a line break (possible header injection)

**How to fix:** Remove line breaks (CR/LF) from the subject and headers. Set recipients with `to`/`replyTo`, not `headers`. Header names use letters, digits and dashes.

## MIU_E_MAIL_SEND_FAILED

- **Package:** `@miujs/mail`
- **HTTP status:** 502
- **Source:** [`mail/src/mailer.ts`](../packages/mail/src/mailer.ts), [`mail/src/transports.ts`](../packages/mail/src/transports.ts)

**What it means:**

- Sending email via {transport} failed: {err}
- {kind} rejected the email (HTTP {status}){detail}

**How to fix:**

- Check the transport's credentials and the provider's status; the error above comes from the provider.
- Check the API key, that the sender domain is verified with the provider, and the recipient address.

## MIU_E_MAIL_TEMPLATE_UNKNOWN

- **Package:** `@miujs/mail`
- **HTTP status:** 500
- **Source:** [`mail/src/mailer.ts`](../packages/mail/src/mailer.ts)

**What it means:** No email template named {msg.template}

**How to fix:** Use one of: {…}; or register it in templates. (otherwise: Register it with mail({ templates: [defineTemplate(name, render)] }).)

## MIU_E_MAIL_TIMEOUT

- **Package:** `@miujs/mail`
- **HTTP status:** 504
- **Source:** [`mail/src/transports.ts`](../packages/mail/src/transports.ts)

**What it means:** {provider} did not answer within {ms} ms

**How to fix:** Check the provider's status and your network; raise the transport's timeoutMs if it is just slow. The email may or may not have been sent.

## MIU_E_MAIL_TRANSPORT_MISSING

- **Package:** `@miujs/mail`
- **HTTP status:** 500
- **Source:** [`mail/src/mailer.ts`](../packages/mail/src/mailer.ts)

**What it means:** No mail transport configured in production

**How to fix:** Pass a transport: mail({ transport: resendTransport(), from }) (reads RESEND_API_KEY), or httpTransport({ url, map }) for another provider. consoleTransport() only logs.

## MIU_E_ACCESS_ALREADY_MEMBER

- **Package:** `@miujs/access`
- **HTTP status:** 409
- **Source:** [`access/src/routes.ts`](../packages/access/src/routes.ts)

**What it means:** {email} is already a member

**How to fix:** Change their role with PATCH /orgs/:orgId/members/:userId instead.

## MIU_E_ACCESS_APP_URL_MISSING

- **Package:** `@miujs/access`
- **HTTP status:** 500
- **Source:** [`access/src/routes.ts`](../packages/access/src/routes.ts)

**What it means:** No public URL for invite links

**How to fix:** Set APP_URL in the environment, or pass access({ appUrl }) or access({ inviteUrl: (token) =&gt; ... }).

## MIU_E_ACCESS_DATABASE_MISSING

- **Package:** `@miujs/access`
- **HTTP status:** 500
- **Source:** [`access/src/plugin.ts`](../packages/access/src/plugin.ts)

**What it means:** access() needs a database for organizations

**How to fix:** Pass access({ database }) (e.g. sqlite() or d1("DB")), or add db() from @miujs/db before access() in plugins.

## MIU_E_ACCESS_EMAIL_UNVERIFIED

- **Package:** `@miujs/access`
- **HTTP status:** 403
- **Source:** [`access/src/routes.ts`](../packages/access/src/routes.ts)

**What it means:** Confirm your email address before accepting an invitation

**How to fix:** Open the link in the confirmation email (or request a new one with POST /auth/verify-email/request), then accept the invitation again.

## MIU_E_ACCESS_INVITE_EMAIL_MISMATCH

- **Package:** `@miujs/access`
- **HTTP status:** 403
- **Source:** [`access/src/routes.ts`](../packages/access/src/routes.ts)

**What it means:** This invitation was sent to a different email address

**How to fix:** Sign in with the account for the invited email, or ask for an invitation to your email.

## MIU_E_ACCESS_INVITE_EXPIRED

- **Package:** `@miujs/access`
- **HTTP status:** 410
- **Source:** [`access/src/routes.ts`](../packages/access/src/routes.ts)

**What it means:** This invitation has expired

**How to fix:** Ask an organization owner to send a new invitation.

## MIU_E_ACCESS_INVITE_INVALID

- **Package:** `@miujs/access`
- **HTTP status:** 404
- **Source:** [`access/src/routes.ts`](../packages/access/src/routes.ts)

**What it means:** Invitation not found

**How to fix:** Check the link, or ask for a new invitation.

## MIU_E_ACCESS_INVITE_USED

- **Package:** `@miujs/access`
- **HTTP status:** 410
- **Source:** [`access/src/routes.ts`](../packages/access/src/routes.ts)

**What it means:** This invitation has already been used

**How to fix:** Ask for a new invitation.

## MIU_E_ACCESS_LAST_OWNER

- **Package:** `@miujs/access`
- **HTTP status:** 409
- **Source:** [`access/src/routes.ts`](../packages/access/src/routes.ts)

**What it means:** This is the organization's last {ownerRole}

**How to fix:** Make another member {ownerRole} first (PATCH /orgs/:orgId/members/:userId with { "role": "{ownerRole}" }), then try again.

## MIU_E_ACCESS_MAILER_MISSING

- **Package:** `@miujs/access`
- **HTTP status:** 500
- **Source:** [`access/src/routes.ts`](../packages/access/src/routes.ts)

**What it means:** No mailer configured to send invitations

**How to fix:** Pass access({ mailer }) with a send({ to, subject, html, text }) method (e.g. from @miujs/mail).

## MIU_E_ACCESS_NO_ORG

- **Package:** `@miujs/access`
- **HTTP status:** 400
- **Source:** [`access/src/plugin.ts`](../packages/access/src/plugin.ts)

**What it means:** No organization selected for this request

**How to fix:** Send the organization id in the x-org-id header (or call a route with :orgId, or set the session orgId, depending on access({ orgFrom })). List yours with GET /orgs.

## MIU_E_ACCESS_NOT_MEMBER

- **Package:** `@miujs/access`
- **HTTP status:** 403
- **Source:** [`access/src/plugin.ts`](../packages/access/src/plugin.ts)

**What it means:** You are not a member of this organization

**How to fix:** Use an organization id from GET /orgs, or ask one of its owners to invite you.

## MIU_E_ACCESS_OWNER_ROLE_MISSING

- **Package:** `@miujs/access`
- **HTTP status:** 500
- **Source:** [`access/src/plugin.ts`](../packages/access/src/plugin.ts)

**What it means:** access() needs a "{ownerRole}" role

**How to fix:** Add {ownerRole}: ["*"] to defineRoles(), or set access({ ownerRole }) to an existing role.

## MIU_E_ACCESS_PERMISSION_INVALID

- **Package:** `@miujs/access`
- **HTTP status:** 500
- **Source:** [`access/src/permissions.ts`](../packages/access/src/permissions.ts)

**What it means:** Invalid permission {permission} in {where}

**How to fix:** Write permissions as "resource:action" (letters, digits, _ . -), with "*" for either side, or "*" alone for everything. Example: "contacts:read", "contacts:*".

## MIU_E_ACCESS_PLUGIN_MISSING

- **Package:** `@miujs/access`
- **HTTP status:** 500
- **Source:** [`access/src/plugin.ts`](../packages/access/src/plugin.ts)

**What it means:** tenantScope() needs the access plugin

**How to fix:** Add access({ roles }) to miu({ plugins }) after auth().

## MIU_E_ACCESS_POLICY_INVALID

- **Package:** `@miujs/access`
- **HTTP status:** 500
- **Source:** [`access/src/permissions.ts`](../packages/access/src/permissions.ts)

**What it means:**

- Invalid policy resource {resource}
- Policy rule "{resource}:{action}" must be a function

**How to fix:**

- Name the resource as in permissions, e.g. policy("contacts", { update: ... }).
- Write policy("{resource}", { {action}: ({ user, record }) =&gt; boolean }).

## MIU_E_ACCESS_ROLE_TOO_HIGH

- **Package:** `@miujs/access`
- **HTTP status:** 403
- **Source:** [`access/src/routes.ts`](../packages/access/src/routes.ts)

**What it means:** Your role ({mine}) cannot grant or change the role "{target}"

**How to fix:** Only someone whose role includes every permission of "{target}" can do this. Ask an owner.

## MIU_E_ACCESS_ROLE_UNKNOWN

- **Package:** `@miujs/access`
- **HTTP status:** 400
- **Source:** [`access/src/routes.ts`](../packages/access/src/routes.ts)

**What it means:** Unknown role {role}

**How to fix:** Use one of: {opts.roles}.

## MIU_E_ACCESS_SESSION_MISSING

- **Package:** `@miujs/access`
- **HTTP status:** 500
- **Source:** [`access/src/plugin.ts`](../packages/access/src/plugin.ts)

**What it means:** access({ orgFrom: "session" }) needs the session plugin

**How to fix:** Add session() before access() in plugins, or use orgFrom: "header".

## MIU_E_AUDIT_ANCHOR_FAILED

- **Package:** `@miujs/audit`
- **HTTP status:** 502
- **Source:** [`audit/src/anchor.ts`](../packages/audit/src/anchor.ts)

**What it means:** Anchor sink {url} answered {res.status}

**How to fix:** Check the sink URL and credentials; the anchor was not saved, so retry on the next run.

## MIU_E_AUDIT_ANCHOR_INVALID

- **Package:** `@miujs/audit`
- **HTTP status:** 500
- **Source:** [`audit/src/anchor.ts`](../packages/audit/src/anchor.ts)

**What it means:** Invalid audit anchor: {why}

**How to fix:** Pass anchors exactly as anchorHead wrote them: objects { seq, hash, at, keyId, signature } or their JSON strings.

## MIU_E_AUDIT_APPEND_CONFLICT

- **Package:** `@miujs/audit`
- **HTTP status:** 503
- **Source:** [`audit/src/store.ts`](../packages/audit/src/store.ts)

**What it means:** Could not append to the audit log: too many concurrent writers

**How to fix:** Retry the request. If this persists, check for a stuck writer or reduce write concurrency.

## MIU_E_AUDIT_CHAIN_BROKEN

- **Package:** `@miujs/audit`
- **HTTP status:** 500
- **Source:** [`audit/src/store.ts`](../packages/audit/src/store.ts)

**What it means:** Audit chain is broken at seq {check.brokenAt}; refusing to purge

**How to fix:** Investigate with verifyChain(store) before deleting anything: purging now could hide tampering.

## MIU_E_AUDIT_INVALID

- **Package:** `@miujs/audit`
- **HTTP status:** 500
- **Source:** [`audit/src/plugin.ts`](../packages/audit/src/plugin.ts), [`audit/src/store.ts`](../packages/audit/src/store.ts)

**What it means:**

- Invalid audit entry: expected an object
- Invalid audit entries: expected an array
- Invalid audit entry: {why}

**How to fix:**

- Call ctx.audit.log({ action: "update", resource: "contacts", ... }).
- Call logMany([{ action, resource, ... }, ...]).
- Call ctx.audit.log({ action: "update", resource: "contacts", resourceId, before, after }) with non-empty action and resource strings.

## MIU_E_AUDIT_KEY_MISSING

- **Package:** `@miujs/audit`
- **HTTP status:** 500
- **Source:** [`audit/src/store.ts`](../packages/audit/src/store.ts)

**What it means:** The audit chain is HMAC-signed but no key is configured for this append

**How to fix:** Set AUDIT_HMAC_KEY (or audit({ key }) / dbAuditStore(db, { key })) to the key used so far; appending unkeyed rows would downgrade the chain.

## MIU_E_AUDIT_KEY_WEAK

- **Package:** `@miujs/audit`
- **HTTP status:** 500
- **Source:** [`audit/src/keys.ts`](../packages/audit/src/keys.ts), [`audit/src/plugin.ts`](../packages/audit/src/plugin.ts)

**What it means:**

- Audit HMAC key rejected: {why}
- audit({ emailSalt }) is too short

**How to fix:**

- Use a random secret of at least {MIN_KEY_LENGTH} characters, e.g. `openssl rand -base64 48`, in AUDIT_HMAC_KEY or audit({ key }). To rotate, list keys newest first: [newKey, oldKey].
- Use a random secret of at least {MIN_KEY_LENGTH} characters, or omit it to reuse the audit key.

## MIU_E_AUDIT_ORG_MISMATCH

- **Package:** `@miujs/audit`
- **HTTP status:** 403
- **Source:** [`audit/src/plugin.ts`](../packages/audit/src/plugin.ts)

**What it means:** You can only read the audit log of the active organization

**How to fix:** Drop the org filter, or select that organization (x-org-id) if you belong to it.

## MIU_E_AUDIT_QUERY_INVALID

- **Package:** `@miujs/audit`
- **HTTP status:** 400
- **Source:** [`audit/src/store.ts`](../packages/audit/src/store.ts)

**What it means:** Invalid audit query: {why}

**How to fix:** Use limit 1–1000, since/until as epoch milliseconds or ISO dates, and cursor exactly as returned in nextCursor.

## MIU_E_AUDIT_RETENTION_INVALID

- **Package:** `@miujs/audit`
- **HTTP status:** 500
- **Source:** [`audit/src/store.ts`](../packages/audit/src/store.ts)

**What it means:** Invalid retention: {days} days

**How to fix:** Pass a finite number of days ≥ 0, e.g. purgeOlderThan(store, 365 * 6).

## MIU_E_AUDIT_SINK_INVALID

- **Package:** `@miujs/audit`
- **HTTP status:** 500
- **Source:** [`audit/src/anchor.ts`](../packages/audit/src/anchor.ts)

**What it means:** httpSink needs an http(s) URL, got {url}

**How to fix:** Pass the full endpoint, e.g. httpSink("https://anchors.example.com/audit").

## MIU_E_AUDIT_SINK_MISSING

- **Package:** `@miujs/audit`
- **HTTP status:** 500
- **Source:** [`audit/src/anchor.ts`](../packages/audit/src/anchor.ts)

**What it means:** Anchor sink binding "{sink}" is not configured

**How to fix:** Add an R2 bucket or KV namespace binding named {sink} (in a different account or with write-only credentials if you can), or pass a sink object such as fileSink(path) or httpSink(url).

## MIU_E_AUDIT_SINK_UNSUPPORTED

- **Package:** `@miujs/audit`
- **HTTP status:** 500
- **Source:** [`audit/src/anchor.ts`](../packages/audit/src/anchor.ts)

**What it means:** fileSink() needs a filesystem

**How to fix:** On Workers use an R2 bucket or KV binding: anchorHead(store, "AUDIT_ANCHORS").

## MIU_E_AUDIT_STORE_MISSING

- **Package:** `@miujs/audit`
- **HTTP status:** 500
- **Source:** [`audit/src/plugin.ts`](../packages/audit/src/plugin.ts)

**What it means:** audit() needs a store

**How to fix:** Pass audit({ store: dbAuditStore(database) }) (or memoryAuditStore() in tests).

## MIU_E_AUDIT_TABLE_INVALID

- **Package:** `@miujs/audit`
- **HTTP status:** 500
- **Source:** [`audit/src/store.ts`](../packages/audit/src/store.ts)

**What it means:** Invalid audit table name {table}

**How to fix:** Use letters, digits and underscores, starting with a letter or underscore.

## MIU_E_WORKFLOW_ACTION_UNKNOWN

- **Package:** `@miujs/workflows`
- **HTTP status:** 400
- **Source:** [`workflows/src/errors.ts`](../packages/workflows/src/errors.ts)

**What it means:** Action "{action}" is not registered

**How to fix:** Use one of: {…}, or register it with defineAction("{action}", { params, run }) and pass it to fromJson(spec, { actions }).

## MIU_E_WORKFLOW_APPROVAL_NOT_PENDING

- **Package:** `@miujs/workflows`
- **HTTP status:** 404
- **Source:** [`workflows/src/errors.ts`](../packages/workflows/src/errors.ts)

**What it means:** Run {runId} has no pending approval named "{step}"

**How to fix:** Check GET /workflows/runs/:id: the run must be waiting on that approval step (it may have been decided or timed out).

## MIU_E_WORKFLOW_CONFIG

- **Package:** `@miujs/workflows`
- **HTTP status:** 500
- **Source:** [`workflows/src/actions.ts`](../packages/workflows/src/actions.ts), [`workflows/src/define.ts`](../packages/workflows/src/define.ts), [`workflows/src/engine.ts`](../packages/workflows/src/engine.ts), [`workflows/src/errors.ts`](../packages/workflows/src/errors.ts), [`workflows/src/plugin.ts`](../packages/workflows/src/plugin.ts), [`workflows/src/routes.ts`](../packages/workflows/src/routes.ts)

**What it means:**

- defineAction needs a name like "update_record", got {name}
- Action "{name}": params must be a t schema
- Action "{name}": run must be a function
- Action "{name}": retries must be a whole number &gt;= 0
- on() needs an event name, got {event}
- webhook() needs a path starting with "/", got {path}

**How to fix:**

- Call defineAction("update_record", { params, run }).
- Pass `params: t.object({ ... })`.
- Pass `run: async (params, ctx) => { ... }`.
- Pass `retries: 3` (or 0).
- Call on("contact.created").
- Call webhook("/hooks/form").

## MIU_E_WORKFLOW_DUPLICATE

- **Package:** `@miujs/workflows`
- **HTTP status:** 500
- **Source:** [`workflows/src/errors.ts`](../packages/workflows/src/errors.ts)

**What it means:** Two workflows are named "{name}"

**How to fix:** Give each defineWorkflow() / fromJson() a unique name.

## MIU_E_WORKFLOW_DURATION

- **Package:** `@miujs/workflows`
- **HTTP status:** 400
- **Source:** [`workflows/src/errors.ts`](../packages/workflows/src/errors.ts)

**What it means:** Invalid duration {value}

**How to fix:** Use a positive number of milliseconds or a string like "500ms", "30s", "5m", "12h", "1d", "2w" (also "3 days", "2 hours").

## MIU_E_WORKFLOW_EVENT_RESERVED

- **Package:** `@miujs/workflows`
- **HTTP status:** 400
- **Source:** [`workflows/src/errors.ts`](../packages/workflows/src/errors.ts)

**What it means:** The event name "{name}" is reserved

**How to fix:** Approvals are decided with POST /workflows/approvals/:runId/:step, not by emitting events. Use another event name.

## MIU_E_WORKFLOW_EXPRESSION

- **Package:** `@miujs/workflows`
- **HTTP status:** 400
- **Source:** [`workflows/src/errors.ts`](../packages/workflows/src/errors.ts)

**What it means:** Invalid expression {source}: {problem}{at}

**How to fix:** Expressions support literals ('text', 42, true, null, [a, b]), paths (data.x, input.x, steps.&lt;id&gt;.output.x), == != &gt; &gt;= &lt; &lt;=, && || !, parentheses and `in`. Nothing else (no calls, no assignment).

## MIU_E_WORKFLOW_MAILER_MISSING

- **Package:** `@miujs/workflows`
- **HTTP status:** 500
- **Source:** [`workflows/src/errors.ts`](../packages/workflows/src/errors.ts)

**What it means:** The send_email action has no mailer

**How to fix:** Pass workflows({ mailer: { send(msg) {...} } }) (any object with send(), e.g. the @miujs/mail client), or add a plugin named "mail" that has send().

## MIU_E_WORKFLOW_NOT_APPROVER

- **Package:** `@miujs/workflows`
- **HTTP status:** 403
- **Source:** [`workflows/src/errors.ts`](../packages/workflows/src/errors.ts)

**What it means:** You are not an approver for step "{step}"

**How to fix:** Sign in as a user with one of the approver roles (or ids) listed in the run's step timeline.

## MIU_E_WORKFLOW_RUN_NOT_FOUND

- **Package:** `@miujs/workflows`
- **HTTP status:** 404
- **Source:** [`workflows/src/errors.ts`](../packages/workflows/src/errors.ts)

**What it means:** Workflow run {id} not found

**How to fix:** List runs with GET /workflows/runs (or the workflow_runs MCP tool) to find a valid id.

## MIU_E_WORKFLOW_RUN_STATE

- **Package:** `@miujs/workflows`
- **HTTP status:** 409
- **Source:** [`workflows/src/errors.ts`](../packages/workflows/src/errors.ts)

**What it means:** Cannot {action} run {id}: it is {status}

**How to fix:** Only {allowed} runs can be {action}.

## MIU_E_WORKFLOW_SIGNATURE

- **Package:** `@miujs/workflows`
- **HTTP status:** 401
- **Source:** [`workflows/src/errors.ts`](../packages/workflows/src/errors.ts)

**What it means:** Webhook signature is missing or does not match

**How to fix:** Send the hex HMAC-SHA256 of the raw request body, keyed with the webhook secret, in the configured header ("sha256=" prefix optional).

## MIU_E_WORKFLOW_SPEC_INVALID

- **Package:** `@miujs/workflows`, `@miujs/admin`
- **HTTP status:** 400
- **Source:** [`admin/src/ui/workflow-pages.ts`](../packages/admin/src/ui/workflow-pages.ts), [`workflows/src/errors.ts`](../packages/workflows/src/errors.ts)

**What it means:**

- The workflow has {r.issues.length} problem(s)
- Invalid workflow spec{name}: {issues}

**How to fix:** Fix the issues listed in details.issues (each has a path and a fix), then save again.

## MIU_E_WORKFLOW_STEP_DUPLICATE

- **Package:** `@miujs/workflows`
- **HTTP status:** 500
- **Source:** [`workflows/src/errors.ts`](../packages/workflows/src/errors.ts)

**What it means:** Workflow "{workflow}" used the step name "{step}" twice in one run

**How to fix:** Step names identify journaled results, so each must be unique per run. In loops, include the index or item id: step.run(`send-${i}`, ...).

## MIU_E_WORKFLOW_UNKNOWN

- **Package:** `@miujs/workflows`
- **HTTP status:** 404
- **Source:** [`workflows/src/errors.ts`](../packages/workflows/src/errors.ts)

**What it means:** Workflow "{name}" is not registered

**How to fix:** Add it to workflows({ workflows: [...] }). Registered: {known.length}.

## MIU_E_AI_AUTH

- **Package:** `@miujs/ai`
- **HTTP status:** 500
- **Source:** [`ai/src/errors.ts`](../packages/ai/src/errors.ts)

**What it means:** The {provider} API rejected the credentials ({status}): {message}

**How to fix:** Check that {KEY_ENV} is a valid, active key for this provider and account.

## MIU_E_AI_BAD_REQUEST

- **Package:** `@miujs/ai`
- **HTTP status:** 500
- **Source:** [`ai/src/errors.ts`](../packages/ai/src/errors.ts)

**What it means:** The {provider} API rejected the request ({status}): {message}

**How to fix:** Check the model id and options against the provider's docs; the provider message above says which field is wrong.

## MIU_E_AI_BINDING

- **Package:** `@miujs/ai`
- **HTTP status:** 500
- **Source:** [`ai/src/errors.ts`](../packages/ai/src/errors.ts), [`ai/src/providers/workers.ts`](../packages/ai/src/providers/workers.ts), [`ai/src/vectors.ts`](../packages/ai/src/vectors.ts)

**What it means:** {kind} binding {name} is not available in env

**How to fix:**

- Add `[ai] binding = "{name}"` to wrangler.toml (Workers AI only runs on Cloudflare; use anthropic() or openaiCompatible() locally).
- Add [[vectorize]] binding = "{binding}" index_name = "&lt;your index&gt;" to wrangler.toml (create it with `wrangler vectorize create`). Locally, use memoryVectors() or sqliteVectors(db).

## MIU_E_AI_CONFIG

- **Package:** `@miujs/ai`
- **HTTP status:** 500
- **Source:** [`ai/src/client.ts`](../packages/ai/src/client.ts), [`ai/src/errors.ts`](../packages/ai/src/errors.ts), [`ai/src/providers/gateway.ts`](../packages/ai/src/providers/gateway.ts), [`ai/src/providers/openai.ts`](../packages/ai/src/providers/openai.ts), [`ai/src/tools.ts`](../packages/ai/src/tools.ts), [`ai/src/vectors.ts`](../packages/ai/src/vectors.ts)

**What it means:**

- No model set for the {p.name} provider
- No input for the model
- object() needs a t.object(...) schema
- No embedding model set for the {ep.name} provider
- aiGateway() needs accountId and gatewayId
- openaiCompatible() needs a baseUrl

**How to fix:**

- Pass a model: ai({ provider, model: "..." }), the provider's `model` option, or { model } per call.
- Pass `prompt` (a string) or `messages` (an array of { role, content }).
- Wrap the value in an object, e.g. schema: t.object({ items: t.array(...) }).
- Pass ai({ embeddings: { model } }) or the provider's `embedModel` option.
- Pass aiGateway({ accountId, gatewayId }, provider) with the ids from the Cloudflare dashboard (AI &gt; AI Gateway).
- Pass the API root, e.g. openaiCompatible({ baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" }).

## MIU_E_AI_INVALID_OUTPUT

- **Package:** `@miujs/ai`
- **HTTP status:** 502
- **Source:** [`ai/src/errors.ts`](../packages/ai/src/errors.ts)

**What it means:** The model's output did not match the schema after a retry: {issues}

**How to fix:** Simplify the schema, describe each field (`description`), make hard fields optional, or use a more capable model.

## MIU_E_AI_MISSING_KEY

- **Package:** `@miujs/ai`
- **HTTP status:** 500
- **Source:** [`ai/src/errors.ts`](../packages/ai/src/errors.ts)

**What it means:** No API key for the {provider} provider: env.{envName} is not set

**How to fix:** Set {envName} in the environment (on Workers: `wrangler secret put {envName}`), or pass {provider}({ apiKey }) from your own secret store.

## MIU_E_AI_PROVIDER_ERROR

- **Package:** `@miujs/ai`
- **HTTP status:** 502
- **Source:** [`ai/src/errors.ts`](../packages/ai/src/errors.ts)

**What it means:** The {provider} API failed{status}: {message}

**How to fix:** The provider is down or overloaded. It was retried with backoff; try again later or raise `retries`.

## MIU_E_AI_RATE_LIMITED

- **Package:** `@miujs/ai`
- **HTTP status:** 429
- **Source:** [`ai/src/errors.ts`](../packages/ai/src/errors.ts)

**What it means:** The {provider} API is rate limiting this app

**How to fix:** {retryAfter}Lower request volume, raise `retries` in ai({ retries }), cache repeated prompts, or ask the provider for a higher rate limit.

## MIU_E_AI_REFUSED

- **Package:** `@miujs/ai`
- **HTTP status:** 502
- **Source:** [`ai/src/errors.ts`](../packages/ai/src/errors.ts)

**What it means:** The {provider} model declined to answer this request

**How to fix:** Rephrase the request. For Claude, the response's stop_reason was `refusal`; see the provider's refusal docs.

## MIU_E_AI_TIMEOUT

- **Package:** `@miujs/ai`
- **HTTP status:** 504
- **Source:** [`ai/src/errors.ts`](../packages/ai/src/errors.ts)

**What it means:** The {provider} API did not answer within {ms} ms

**How to fix:** Raise ai({ timeoutMs }), lower maxTokens, or use ctx.ai.stream() for long outputs.

## MIU_E_AI_UNSUPPORTED

- **Package:** `@miujs/ai`
- **HTTP status:** 500
- **Source:** [`ai/src/client.ts`](../packages/ai/src/client.ts), [`ai/src/errors.ts`](../packages/ai/src/errors.ts), [`ai/src/providers/anthropic.ts`](../packages/ai/src/providers/anthropic.ts), [`ai/src/providers/gateway.ts`](../packages/ai/src/providers/gateway.ts)

**What it means:** The {provider} provider does not support {feature}

**How to fix:**

- Set an embeddings provider: ai({ provider, embeddings: { provider: workersAI() } }) or openaiCompatible({ baseUrl, embedModel: "text-embedding-3-small" }).
- {req.model} rejects sampling parameters. Remove `temperature`; steer output with the prompt instead, or use a model that accepts it (e.g. claude-haiku-4-5).
- Wrap anthropic(), openaiCompatible() or workersAI(), or point your provider's baseUrl at the gateway yourself.

## MIU_E_ADMIN_ACTION_UNKNOWN

- **Package:** `@miujs/admin`
- **HTTP status:** 404
- **Source:** [`admin/src/errors.ts`](../packages/admin/src/errors.ts)

**What it means:** {resource} has no action "{action}"

**How to fix:** Use one of: {…}. (otherwise: This resource defines no actions.)

## MIU_E_ADMIN_CURSOR_INVALID

- **Package:** `@miujs/admin`
- **HTTP status:** 400
- **Source:** [`admin/src/errors.ts`](../packages/admin/src/errors.ts)

**What it means:** Invalid cursor

**How to fix:** Pass the nextCursor from the previous page unchanged, with the same sort and filters.

## MIU_E_ADMIN_FIELDS_INVALID

- **Package:** `@miujs/admin`
- **HTTP status:** 400
- **Source:** [`admin/src/errors.ts`](../packages/admin/src/errors.ts)

**What it means:** Unknown field(s) in fields: {…}

**How to fix:** Use a comma-separated list of: {…}.

## MIU_E_ADMIN_FILTER_INVALID

- **Package:** `@miujs/admin`
- **HTTP status:** 400
- **Source:** [`admin/src/errors.ts`](../packages/admin/src/errors.ts)

**What it means:** Invalid filter: {message}

**How to fix:** Send filter as JSON {"field": {"op": value}} with op one of eq, ne, gt, gte, lt, lte, in, contains, isNull, or as query keys like ?stage=lead&value[gte]=1000. See GET /_admin/schema for fields and operators.

## MIU_E_ADMIN_HOOK_REJECTED

- **Package:** `@miujs/admin`
- **HTTP status:** 400
- **Source:** [`admin/src/errors.ts`](../packages/admin/src/errors.ts)

**What it means:** See the source; this code has no static message.

**How to fix:** A resource hook refused this change. Read the message for what to change.

## MIU_E_ADMIN_IMPORT_EMPTY

- **Package:** `@miujs/admin`
- **HTTP status:** 400
- **Source:** [`admin/src/errors.ts`](../packages/admin/src/errors.ts)

**What it means:** The CSV has no data rows

**How to fix:** Send a CSV with a header row and at least one data row, as `csv` (JSON) or a `file` upload.

## MIU_E_ADMIN_IMPORT_INVALID

- **Package:** `@miujs/admin`
- **HTTP status:** 400
- **Source:** [`admin/src/errors.ts`](../packages/admin/src/errors.ts)

**What it means:** Import refused: {rowErrors.length} row(s) have errors; nothing was written

**How to fix:** Fix the rows listed in details.rows (row 1 is the first data row after the header), then import again. Use dryRun: true to check first.

## MIU_E_ADMIN_IMPORT_TOO_LARGE

- **Package:** `@miujs/admin`
- **HTTP status:** 413
- **Source:** [`admin/src/errors.ts`](../packages/admin/src/errors.ts)

**What it means:** The CSV has more than {max} rows

**How to fix:** Split the file into chunks of at most {max} rows.

## MIU_E_ADMIN_IN_USE

- **Package:** `@miujs/admin`
- **HTTP status:** 409
- **Source:** [`admin/src/errors.ts`](../packages/admin/src/errors.ts)

**What it means:** This {resource} record is still referenced by other records

**How to fix:** Delete or re-link the records that point to it first, or define the relation with onDelete: "set null" or "cascade".

## MIU_E_ADMIN_INCLUDE_INVALID

- **Package:** `@miujs/admin`
- **HTTP status:** 400
- **Source:** [`admin/src/errors.ts`](../packages/admin/src/errors.ts)

**What it means:** Cannot include: {…}

**How to fix:** Include relation fields only: {…}. (otherwise: This resource has no relation fields to include.)

## MIU_E_ADMIN_NO_TENANT

- **Package:** `@miujs/admin`
- **HTTP status:** 400
- **Source:** [`admin/src/errors.ts`](../packages/admin/src/errors.ts)

**What it means:** {resource} is organization-scoped but no organization is active

**How to fix:** Send the organization id (x-org-id header with @miujs/access's default orgFrom), or pass orgId to the admin data API.

## MIU_E_ADMIN_RECORD_NOT_FOUND

- **Package:** `@miujs/admin`
- **HTTP status:** 404
- **Source:** [`admin/src/errors.ts`](../packages/admin/src/errors.ts)

**What it means:** {resource} {id} not found

**How to fix:** Check the id. List records with GET /{resource}; records of other organizations and deleted records are not visible.

## MIU_E_ADMIN_RELATION_INVALID

- **Package:** `@miujs/admin`
- **HTTP status:** 400
- **Source:** [`admin/src/errors.ts`](../packages/admin/src/errors.ts)

**What it means:** {resource}.{fieldName}: {target} {id} does not exist

**How to fix:** Use the id of an existing {target} record in the same organization (GET /{target}).

## MIU_E_ADMIN_RESOURCE_UNKNOWN

- **Package:** `@miujs/admin`
- **HTTP status:** 404
- **Source:** [`admin/src/errors.ts`](../packages/admin/src/errors.ts)

**What it means:** No admin resource named "{name}"

**How to fix:** Use one of: {none}.

## MIU_E_ADMIN_SORT_INVALID

- **Package:** `@miujs/admin`
- **HTTP status:** 400
- **Source:** [`admin/src/errors.ts`](../packages/admin/src/errors.ts)

**What it means:** Cannot sort by {value}

**How to fix:** Sort by one field, prefixed with - for descending. Sortable: {…}.

## MIU_E_ADMIN_UI_CONFIG

- **Package:** `@miujs/admin`
- **HTTP status:** 500
- **Source:** [`admin/src/ui/plugin.ts`](../packages/admin/src/ui/plugin.ts)

**What it means:**

- Invalid adminUI path {path}
- Invalid brand.accent {accent}
- Invalid brand.logo {logo}
- Invalid loginUrl {o.loginUrl}

**How to fix:**

- Use an absolute path without a trailing slash, e.g. "/admin".
- Use a hex color such as "#2557d6".
- Use a same-site path ("/logo.svg") or an https URL.
- Use a same-site path ("/login") or an https URL.

## MIU_E_ADMIN_UI_DATABASE

- **Package:** `@miujs/admin`
- **HTTP status:** 500
- **Source:** [`admin/src/ui/plugin.ts`](../packages/admin/src/ui/plugin.ts)

**What it means:** adminUI() has no database for workflows

**How to fix:** Pass adminUI({ workflows: { database } }).

## MIU_E_ADMIN_UI_NO_ADMIN

- **Package:** `@miujs/admin`
- **HTTP status:** 500
- **Source:** [`admin/src/ui/plugin.ts`](../packages/admin/src/ui/plugin.ts)

**What it means:** adminUI() needs the admin() (or crm()) plugin

**How to fix:** Add admin({ resources }) or crm() to miu({ plugins }) next to adminUI().

## MIU_E_ADMIN_UI_NOT_READY

- **Package:** `@miujs/admin`
- **HTTP status:** 500
- **Source:** [`admin/src/ui/plugin.ts`](../packages/admin/src/ui/plugin.ts)

**What it means:** adminUI() is not set up yet

**How to fix:** Pass adminUI() to miu({ plugins }) together with admin() or crm().

## MIU_E_ADMIN_UNIQUE

- **Package:** `@miujs/admin`
- **HTTP status:** 409
- **Source:** [`admin/src/errors.ts`](../packages/admin/src/errors.ts)

**What it means:** Another {resource} record already has this {fieldName}

**How to fix:** Use a different {fieldName}, or update the existing record instead.

## MIU_E_ADMIN_VIEW_UNKNOWN

- **Package:** `@miujs/admin`
- **HTTP status:** 400
- **Source:** [`admin/src/errors.ts`](../packages/admin/src/errors.ts)

**What it means:** {resource} has no view "{view}"

**How to fix:** Use one of: {…}. (otherwise: This resource has no saved views.)

## MIU_E_ADMIN_WORKFLOW_NAME_TAKEN

- **Package:** `@miujs/admin`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`admin/src/ui/workflow-pages.ts`](../packages/admin/src/ui/workflow-pages.ts)

**What it means:** The workflow has {r.issues.length} problem(s)

**How to fix:** Fix the issues listed in details.issues (each has a path and a fix), then save again.

## MIU_E_ADMIN_WORKFLOW_PUBLISH

- **Package:** `@miujs/admin`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`admin/src/ui/workflow-pages.ts`](../packages/admin/src/ui/workflow-pages.ts)

**What it means:** See the source; this code has no static message.

**How to fix:** Fix the workflow and save a new version, then publish it.

## MIU_E_ADMIN_WORKFLOWS_MISSING

- **Package:** `@miujs/admin`
- **HTTP status:** 404
- **Source:** [`admin/src/ui/workflow-pages.ts`](../packages/admin/src/ui/workflow-pages.ts)

**What it means:** Workflows are not enabled

**How to fix:** Add workflows() from @miujs/workflows to the app.

## MIU_E_GAME_ACHIEVEMENT_INVALID

- **Package:** `@miujs/game`
- **HTTP status:** 500
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** Achievement "{id}" is invalid

**How to fix:** Each achievement needs an id of letters, digits, _ . or - and { title: string, check: (stats) =&gt; boolean }.

## MIU_E_GAME_ALREADY_QUEUED

- **Package:** `@miujs/game`
- **HTTP status:** 409
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** You are already waiting in "{queue}"

**How to fix:** Poll GET /match/{queue}/status, or DELETE /match/{queue}/leave first.

## MIU_E_GAME_CLIENT_SCORES_DISABLED

- **Package:** `@miujs/game`
- **HTTP status:** 403
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** Leaderboard "{id}" does not accept scores from clients

**How to fix:** Submit scores from the room (board.submit(playerId, score) on the server), or enable clientSubmit: { secret } and send a signed proof.

## MIU_E_GAME_LEADERBOARD_CONFIG

- **Package:** `@miujs/game`
- **HTTP status:** 500
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts), [`game/src/leaderboard.ts`](../packages/game/src/leaderboard.ts)

**What it means:** leaderboard("{opts.id}"): {m}

**How to fix:** Read the message and `details` in the error body, then the source linked above.

## MIU_E_GAME_LOBBY_FULL

- **Package:** `@miujs/game`
- **HTTP status:** 409
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** Lobby is full ({max} players)

**How to fix:** Join another lobby or ask the host to start a new one.

## MIU_E_GAME_LOBBY_NOT_FOUND

- **Package:** `@miujs/game`
- **HTTP status:** 404
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** No such lobby (or its code expired)

**How to fix:** Check the 6-digit code, or create a new lobby with POST /lobbies.

## MIU_E_GAME_LOBBY_NOT_HOST

- **Package:** `@miujs/game`
- **HTTP status:** 403
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** Only the lobby host can start the match

**How to fix:** Ask the host to start, or create your own lobby.

## MIU_E_GAME_LOBBY_NOT_MEMBER

- **Package:** `@miujs/game`
- **HTTP status:** 403
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** You are not in this lobby

**How to fix:** Join it first: POST /lobbies/join with its code.

## MIU_E_GAME_LOBBY_NOT_READY

- **Package:** `@miujs/game`
- **HTTP status:** 409
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** Cannot start: {missing.length}

**How to fix:** Every member must POST /lobbies/:id/ready with { ready: true }, and the lobby needs enough players.

## MIU_E_GAME_LOBBY_STARTED

- **Package:** `@miujs/game`
- **HTTP status:** 409
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** The lobby already started its match

**How to fix:** Connect to the room from GET /lobbies/:id, or create a new lobby.

## MIU_E_GAME_LOOP_NOT_DURABLE

- **Package:** `@miujs/game`
- **HTTP status:** 500
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** fixedStep(room, hz, update) uses a closure, which cannot survive Durable Object hibernation

**How to fix:** Use fixedStep.define("step", { hz, update }) and spread its .timers into defineRoom({ timers }); it re-arms with room.schedule().

## MIU_E_GAME_MATCH_FAILED

- **Package:** `@miujs/game`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`game/src/connect.ts`](../packages/game/src/connect.ts)

**What it means:** See the source; this code has no static message.

**How to fix:** Read the message and `details` in the error body, then the source linked above.

## MIU_E_GAME_MATCH_TIMEOUT

- **Package:** `@miujs/game`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`game/src/connect.ts`](../packages/game/src/connect.ts)

**What it means:** See the source; this code has no static message.

**How to fix:** Read the message and `details` in the error body, then the source linked above.

## MIU_E_GAME_MATCH_UNKNOWN

- **Package:** `@miujs/game`
- **HTTP status:** 404
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** No match "{id}"

**How to fix:** Report results with the match id the room was created with (room.secret / seat info).

## MIU_E_GAME_PLAYER_NOT_FOUND

- **Package:** `@miujs/game`
- **HTTP status:** 404
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** No player "{id}"

**How to fix:** Players are created on first matchmaking join or with store.ensurePlayer(id, name).

## MIU_E_GAME_PROOF_INVALID

- **Package:** `@miujs/game`
- **HTTP status:** 401
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** Score proof is missing or does not match

**How to fix:** Sign the score server-side with signScoreProof(secret, { board, playerId, score, nonce }) and send it as `proof`.

## MIU_E_GAME_QUEUE_CONFIG

- **Package:** `@miujs/game`
- **HTTP status:** 500
- **Source:** [`game/src/cloudflare.ts`](../packages/game/src/cloudflare.ts), [`game/src/connect.ts`](../packages/game/src/connect.ts), [`game/src/errors.ts`](../packages/game/src/errors.ts), [`game/src/leaderboard.ts`](../packages/game/src/leaderboard.ts), [`game/src/matchmaker.ts`](../packages/game/src/matchmaker.ts), [`game/src/queue.ts`](../packages/game/src/queue.ts)

**What it means:**

- Queue "{name}" uses room type "{cfg.room}", which the rooms plugin does not host
- Queue "{name}": {what}

**How to fix:**

- Add it: rooms({ rooms: [{cfg.room}] }), and pass that plugin as matchmaker({ rooms }).
- join failed ({res.status})
- status failed ({r.status})
- e.g. leaderboard({ id: "weekly-wins", ... }).
- Use sort: "desc" for points, "asc" for times.
- e.g. resets: "weekly".

## MIU_E_GAME_QUEUE_UNKNOWN

- **Package:** `@miujs/game`
- **HTTP status:** 404
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** No matchmaking queue "{queue}"

**How to fix:** Use one of: {none}, or add it to matchmaker({ queues }).

## MIU_E_GAME_REGION_INVALID

- **Package:** `@miujs/game`
- **HTTP status:** 400
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** This queue needs a valid region

**How to fix:** Send { "region": one of {…} } in the join body.

## MIU_E_GAME_RESULT_INVALID

- **Package:** `@miujs/game`
- **HTTP status:** 400
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** Invalid match result: {why}

**How to fix:** Pass { winners: [userIds] } or { ranking: [[userIds], ...] } using only players of this match.

## MIU_E_GAME_RESULT_UNSIGNED

- **Package:** `@miujs/game`
- **HTTP status:** 401
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** Match results must come from the room server

**How to fix:** Results are only accepted from the authoritative room: call reportResult() server-side or sign the request with signResult(secret, body).

## MIU_E_GAME_ROOM_CONFIG

- **Package:** `@miujs/game`
- **HTTP status:** 500
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts), [`game/src/lobbies.ts`](../packages/game/src/lobbies.ts), [`game/src/loop.ts`](../packages/game/src/loop.ts), [`game/src/room.ts`](../packages/game/src/room.ts)

**What it means:**

- lobbies() uses room type "{opts.room}", which the rooms plugin does not host
- lobbies(): need 1 &lt;= minPlayers &lt;= maxPlayers and teams &gt;= 1
- fixedStep: hz must be between 0 and 120 (got {hz})
- fixedStep.define: bad timer name "{name}"
- fixedStep.define("{name}"): stepsPerAlarm must be a positive integer (got {batch})
- gameRoom("{type}") declares a client message named "ticket"

**How to fix:**

- Add it: rooms({ rooms: [{opts.room}] }), and pass that plugin as lobbies({ rooms }).
- e.g. lobbies({ minPlayers: 2, maxPlayers: 8, teams: 2 }).
- Use e.g. hz: 20 for a server simulation; render smoothly on clients with snapshotInterpolation().
- Use letters, digits, _ . or -, e.g. fixedStep.define("physics", ...).
- e.g. stepsPerAlarm: 4 runs 4 steps per alarm.
- Rename it: `ticket` is how players present their match ticket.

## MIU_E_GAME_SCORE_INVALID

- **Package:** `@miujs/game`
- **HTTP status:** 400
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** Score rejected: {why}

**How to fix:** Submit a finite number between the leaderboard's minScore and maxScore.

## MIU_E_GAME_SCORE_RATE_LIMITED

- **Package:** `@miujs/game`
- **HTTP status:** 429
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** Too many score submissions

**How to fix:** Submit at most {perMinute} scores per minute per player.

## MIU_E_GAME_SECRET_MISSING

- **Package:** `@miujs/game`
- **HTTP status:** 500
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** No game secret: tickets and result signatures need one on Cloudflare Workers

**How to fix:** Set the MIU_GAME_SECRET variable (wrangler secret put MIU_GAME_SECRET) or pass { secret } to matchmaker()/gameRoom()/lobbies(). Use 32+ random characters.

## MIU_E_GAME_SECRET_WEAK

- **Package:** `@miujs/game`
- **HTTP status:** 500
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** The game secret must be at least 16 characters

**How to fix:** Use 32+ random characters, e.g. crypto.randomUUID() + crypto.randomUUID().

## MIU_E_GAME_STORE_MISSING

- **Package:** `@miujs/game`
- **HTTP status:** 500
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** {what} needs a game store

**How to fix:** Pass { store: gameStore({ database }) } (SQLite locally, D1 on Workers).

## MIU_E_GAME_TICKET_EXPIRED

- **Package:** `@miujs/game`
- **HTTP status:** 401
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** Ticket expired

**How to fix:** Tickets are short-lived: connect to the room right after you are matched, or ask the matchmaker/lobby for a fresh ticket.

## MIU_E_GAME_TICKET_INVALID

- **Package:** `@miujs/game`
- **HTTP status:** 401
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** Ticket rejected: {why}

**How to fix:** Use the ticket the matchmaker or lobby gave you for this room (GET /match/:queue/status); do not edit it.

## MIU_E_GAME_TICKET_REQUIRED

- **Package:** `@miujs/game`
- **HTTP status:** 401
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** Present your match ticket before playing

**How to fix:** Connect with ?ticket=&lt;ticket&gt; and send {"t":"msg","type":"ticket","data":{"ticket":"&lt;ticket&gt;"}} right after the welcome frame (the ticket comes with the match).

## MIU_E_GAME_TICKET_USED

- **Package:** `@miujs/game`
- **HTTP status:** 409
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** This user is already seated in the room as another player

**How to fix:** Reconnect with your resumeToken instead of joining again.

## MIU_E_GAME_TIMEZONE_INVALID

- **Package:** `@miujs/game`
- **HTTP status:** 500
- **Source:** [`game/src/errors.ts`](../packages/game/src/errors.ts)

**What it means:** Unknown time zone "{tz}"

**How to fix:** Use an IANA zone name such as "UTC", "Europe/Paris" or "America/Los_Angeles".

## MIU_E_MIGRATE_APP_KEY

- **Package:** `@miujs/migrate`
- **HTTP status:** 500
- **Source:** [`migrate/src/laravel.ts`](../packages/migrate/src/laravel.ts)

**What it means:** The Laravel APP_KEY is not a valid {want}-byte key for {cipher}

**How to fix:** Copy APP_KEY exactly from the Laravel app's .env, including the "base64:" prefix, and set `cipher` to match config/app.php.

## MIU_E_MIGRATE_CASES

- **Package:** `@miujs/migrate`
- **HTTP status:** 400
- **Source:** [`migrate/src/capture.ts`](../packages/migrate/src/capture.ts)

**What it means:**

- Line {i} of the cases file is not JSON
- Line {i} of the cases file has no method/path

**How to fix:**

- Each line must be one JSON object written by captureMiddleware (JSONL). Remove or fix the line.
- Each case needs at least { method, path }.

## MIU_E_MIGRATE_CONFIG

- **Package:** `@miujs/migrate`
- **HTTP status:** 500
- **Source:** [`migrate/src/capture.ts`](../packages/migrate/src/capture.ts), [`migrate/src/django.ts`](../packages/migrate/src/django.ts), [`migrate/src/laravel.ts`](../packages/migrate/src/laravel.ts), [`migrate/src/proxy.ts`](../packages/migrate/src/proxy.ts), [`migrate/src/verify.ts`](../packages/migrate/src/verify.ts)

**What it means:**

- jsonlFileSink needs a filesystem
- Cannot sign in to Django without the user's password hash
- "{…}" is not a valid table name
- migrateProxy upstream "{upstream}" is not an http(s) URL
- migrateProxy upstream must not contain credentials
- Ignore path "{p}" is not valid

**How to fix:**

- On Workers, pass a sink that writes to R2, KV or a queue.
- Django rejects sessions without _auth_user_hash. Pass login(ctx, id, { passwordHash }) or djangoSession({ passwordHashFor }).
- Pass a plain table name such as "sessions" (letters, digits, underscores, optional schema prefix).
- Pass the old app's base URL, e.g. migrateProxy({ upstream: "http://old-app:8000" }).
- Remove user:pass from the URL; pass migrateProxy({ headers: { authorization: ... } }) instead.
- Use JSONPath like "$.createdAt", "$.items[*].updatedAt", "$.meta.*" or "$..updatedAt".

## MIU_E_MIGRATE_CSRF

- **Package:** `@miujs/migrate`
- **HTTP status:** 403
- **Source:** [`migrate/src/bridge.ts`](../packages/migrate/src/bridge.ts)

**What it means:** Cross-site {ctx.method} blocked: the old app's session cookie was sent without a matching Origin/Referer

**How to fix:** Send the request from this site (browsers add Origin), add the other site to bridgeAuth({ trustedOrigins }), or use a bearer token for API clients.

## MIU_E_MIGRATE_DECRYPT

- **Package:** `@miujs/migrate`
- **HTTP status:** 400
- **Source:** [`migrate/src/laravel.ts`](../packages/migrate/src/laravel.ts)

**What it means:** Could not decrypt the Laravel payload: the MAC or tag is invalid, or the data is malformed

**How to fix:** Check that appKey (and previousKeys) match the Laravel app's APP_KEY / APP_PREVIOUS_KEYS and that `cipher` matches config/app.php.

## MIU_E_MIGRATE_NOT_PORTED

- **Package:** `@miujs/migrate`
- **HTTP status:** not fixed (depends on the call)
- **Source:** [`migrate/src/openapi.ts`](../packages/migrate/src/openapi.ts)

**What it means:** See the source; this code has no static message.

**How to fix:** Read the message and `details` in the error body, then the source linked above.

## MIU_E_MIGRATE_OPENAPI

- **Package:** `@miujs/migrate`
- **HTTP status:** 400
- **Source:** [`migrate/src/openapi.ts`](../packages/migrate/src/openapi.ts)

**What it means:** Not an OpenAPI 3.x document

**How to fix:** Pass the parsed JSON of an OpenAPI 3.0/3.1 spec (FastAPI serves /openapi.json). Convert Swagger 2.0 first, e.g. with swagger2openapi.

## MIU_E_MIGRATE_PHP_CLASS

- **Package:** `@miujs/migrate`
- **HTTP status:** 400
- **Source:** [`migrate/src/php.ts`](../packages/migrate/src/php.ts)

**What it means:** Refusing to unserialize {what}

**How to fix:** Only scalars, arrays and stdClass are read. Keep objects out of the session (store ids), or pass classes: "inert" to read them as plain data.

## MIU_E_MIGRATE_PHP_SERIALIZE

- **Package:** `@miujs/migrate`
- **HTTP status:** 500
- **Source:** [`migrate/src/php.ts`](../packages/migrate/src/php.ts)

**What it means:** Cannot serialize a {value} for PHP

**How to fix:** Store only JSON-like values (strings, numbers, booleans, null, arrays, objects) in a shared session.

## MIU_E_MIGRATE_PHP_UNSERIALIZE

- **Package:** `@miujs/migrate`
- **HTTP status:** 400
- **Source:** [`migrate/src/php.ts`](../packages/migrate/src/php.ts)

**What it means:** Cannot unserialize PHP data: {message}

**How to fix:** Check that the payload is PHP serialize() output (session.serialization = php). For JSON sessions use serialization: "json".

## MIU_E_MIGRATE_SECRET_KEY

- **Package:** `@miujs/migrate`
- **HTTP status:** 500
- **Source:** [`migrate/src/django.ts`](../packages/migrate/src/django.ts)

**What it means:** The Django SECRET_KEY is missing or too short

**How to fix:** Pass djangoSession({ secretKey }) the exact SECRET_KEY from the Django settings (and SECRET_KEY_FALLBACKS if any).

## MIU_E_MIGRATE_SIGNATURE

- **Package:** `@miujs/migrate`
- **HTTP status:** 400
- **Source:** [`migrate/src/django.ts`](../packages/migrate/src/django.ts)

**What it means:** Django signature check failed: {why}

**How to fix:** Check that secretKey (and secretKeyFallbacks) match the Django app's SECRET_KEY / SECRET_KEY_FALLBACKS, and that the salt matches.

## MIU_E_MIGRATE_SIGNATURE_EXPIRED

- **Package:** `@miujs/migrate`
- **HTTP status:** 400
- **Source:** [`migrate/src/django.ts`](../packages/migrate/src/django.ts)

**What it means:** Django signature is older than {opts.maxAge} seconds

**How to fix:** Sign in again on the old app, or raise maxAge to match SESSION_COOKIE_AGE.

## MIU_E_MIGRATE_UPSTREAM

- **Package:** `@miujs/migrate`
- **HTTP status:** 502
- **Source:** [`migrate/src/proxy.ts`](../packages/migrate/src/proxy.ts)

**What it means:** Could not reach the old app at {base.origin} for {req.method} {ctx.path}

**How to fix:** Start the old app, or point migrateProxy({ upstream }) at where it runs (now {base.origin}). This request matched no MiuJS route, so it was forwarded.

## MIU_E_MIGRATE_UPSTREAM_TIMEOUT

- **Package:** `@miujs/migrate`
- **HTTP status:** 504
- **Source:** [`migrate/src/proxy.ts`](../packages/migrate/src/proxy.ts)

**What it means:** The old app at {base.origin} did not answer {req.method} {ctx.path} within {timeout} ms

**How to fix:** Check the old app's health and logs, or raise migrateProxy({ timeout }).

## MIU_E_MIGRATE_WEBSOCKET

- **Package:** `@miujs/migrate`
- **HTTP status:** 501
- **Source:** [`migrate/src/proxy.ts`](../packages/migrate/src/proxy.ts)

**What it means:** WebSocket upgrade on {ctx.path} is not proxied to the old app

**How to fix:** Route this WebSocket path straight to the old app at your load balancer, or port it to MiuJS with a route that calls ctx.upgrade().

## MIU_E_TOUR_ANALYTICS_DISABLED

- **Package:** `@miujs/tour`
- **HTTP status:** 404
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** Analytics are turned off for these tours

**How to fix:** Remove analytics: false from tour({ ... }) to collect events.

## MIU_E_TOUR_ASSET_NOT_FOUND

- **Package:** `@miujs/tour`
- **HTTP status:** 404
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** Asset {id} not found

**How to fix:** Use an asset id from GET /tours/:tour/assets.

## MIU_E_TOUR_ASSET_TYPE

- **Package:** `@miujs/tour`
- **HTTP status:** 415
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** A {sceneType} scene cannot use a {detected} file

**How to fix:** Upload one of: {…} (detected from the file's bytes).

## MIU_E_TOUR_CALLBACK_INVALID

- **Package:** `@miujs/tour`
- **HTTP status:** 401
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** Processor callback signature is missing, wrong or too old

**How to fix:** Sign the exact body: header x-miu-tour-signature: t=&lt;unix seconds&gt;,v1=&lt;hex HMAC-SHA256 of `${t}.${body}`&gt; with the externalProcessor secret. Clocks must agree within 5 minutes.

## MIU_E_TOUR_CALLBACK_STALE

- **Package:** `@miujs/tour`
- **HTTP status:** 409
- **Source:** [`tour/src/processors/external.ts`](../packages/tour/src/processors/external.ts)

**What it means:** Asset {asset.id} is not waiting for run {body.run} (it is {asset.status}, run {asset.attempts})

**How to fix:** Drop this job: a newer run replaced it, or it already finished.

## MIU_E_TOUR_CONFIG

- **Package:** `@miujs/tour`
- **HTTP status:** 500
- **Source:** [`tour/src/processors/external.ts`](../packages/tour/src/processors/external.ts), [`tour/src/runtime.ts`](../packages/tour/src/runtime.ts)

**What it means:**

- externalProcessor needs a secret of 32+ characters
- externalProcessor url {opts.url} is not a URL
- externalProcessor url must use https
- Invalid basePath {opts.basePath}

**How to fix:**

- Generate one with `openssl rand -base64 32` and give the same value to your processing service.
- Pass the full https URL of your processing service, e.g. https://tiler.example.com/jobs.
- Jobs carry signed instructions; send them over https (http is allowed for localhost only).
- Use an absolute path without a trailing slash, e.g. "/tours".

## MIU_E_TOUR_FILES_MISSING

- **Package:** `@miujs/tour`
- **HTTP status:** 500
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** @miujs/tour needs ctx.files from @miujs/files

**How to fix:** Add files({ store }) to miu({ plugins }) and pass the same store to tour({ store }).

## MIU_E_TOUR_FLOORPLAN_NOT_FOUND

- **Package:** `@miujs/tour`
- **HTTP status:** 404
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** No floor plan for floor {floor}

**How to fix:** Create it with PUT /tours/:tour/floorplans/:floor.

## MIU_E_TOUR_GUIDE_ONLY

- **Package:** `@miujs/tour`
- **HTTP status:** 403
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** Only the guide can do that

**How to fix:** Join as the guide with the guide link (it carries #guide=&lt;token&gt;), or follow along.

## MIU_E_TOUR_GUIDE_TOKEN

- **Package:** `@miujs/tour`
- **HTTP status:** 403
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** That guide token is not valid for this live tour

**How to fix:** Open the guide link from POST /tours/:tour/live (the part after #guide=), or start a new live tour.

## MIU_E_TOUR_HOTSPOT_NOT_FOUND

- **Package:** `@miujs/tour`
- **HTTP status:** 404
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** Hotspot {id} not found in this tour

**How to fix:** Use a hotspot id from GET /tours/:tour (scenes[].hotspots[].id).

## MIU_E_TOUR_INVALID

- **Package:** `@miujs/tour`
- **HTTP status:** 400
- **Source:** [`tour/src/analytics.ts`](../packages/tour/src/analytics.ts), [`tour/src/errors.ts`](../packages/tour/src/errors.ts), [`tour/src/processors/external.ts`](../packages/tour/src/processors/external.ts), [`tour/src/routes/admin.ts`](../packages/tour/src/routes/admin.ts)

**What it means:**

- The analytics body is not JSON
- Invalid analytics body: {i}
- `from` is after `to`
- Callback body is not JSON
- Invalid callback: {i}
- Hotspots on a 360° panorama use { yaw, pitch }

**How to fix:**

- Send {"sessionId": "...", "events": [...]}.
- Send up to 50 events with a 16-64 character random sessionId.
- Pass from &lt;= to, both as YYYY-MM-DD.
- Send the JSON documented on externalProcessor().
- Send position: { yaw: -180..180, pitch: -90..90 } in degrees.
- Send position: { x: 0..1, y: 0..1 } (fractions of the image width and height). (otherwise: Send position: { x, y, z } in model units.)

## MIU_E_TOUR_JOBS_NOT_REGISTERED

- **Package:** `@miujs/tour`
- **HTTP status:** 500
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** The queue plugin does not run the tour jobs: {…}

**How to fix:** Pass them to the queue: queue({ jobs: [...yourJobs, ...tourPlugin.jobs.all] }).

## MIU_E_TOUR_LIVE_MISSING

- **Package:** `@miujs/tour`
- **HTTP status:** 500
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** Live guided tours need the realtime rooms plugin

**How to fix:** const live = rooms({ rooms: [guidedTour] }); then miu({ plugins: [live, tour({ live, ... })] }).

## MIU_E_TOUR_LOCKED

- **Package:** `@miujs/tour`
- **HTTP status:** 401
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** Tour {slug} needs a password or a share link

**How to fix:** POST /tours/{slug}/unlock with {"password": "..."}, or open the share link you were given.

## MIU_E_TOUR_NOT_FOUND

- **Package:** `@miujs/tour`
- **HTTP status:** 404
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** Tour {ref} not found

**How to fix:** Use a tour id (tour_...) or slug from GET /tours. Draft and private tours are hidden from viewers who cannot open them.

## MIU_E_TOUR_PASSWORD_WRONG

- **Package:** `@miujs/tour`
- **HTTP status:** 403
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** Wrong tour password

**How to fix:** Check the password with the tour owner.

## MIU_E_TOUR_PROCESSOR_FAILED

- **Package:** `@miujs/tour`
- **HTTP status:** 502
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** Processor "{name}" failed: {message}

**How to fix:** Check the processor's logs and the source file; retry with POST /tours/:tour/assets/:assetId/retry.

## MIU_E_TOUR_PROCESSOR_MISSING

- **Package:** `@miujs/tour`
- **HTTP status:** 500
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** No processor can {step}

**How to fix:** Pass one to tour({ processors: [...] }): vipsProcessor() / gltfTransformProcessor() on a server or container, cloudflareImagesProcessor() or externalProcessor() from Workers.

## MIU_E_TOUR_PROCESSOR_RESULT_INVALID

- **Package:** `@miujs/tour`
- **HTTP status:** 502
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** Processor "{name}" returned an invalid result: {why}

**How to fix:** Return keys under the outputPrefix you were given, with the fields documented on PanoramaResult / ModelResult.

## MIU_E_TOUR_PROCESSOR_UNAVAILABLE

- **Package:** `@miujs/tour`
- **HTTP status:** 500
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts), [`tour/src/plugin.ts`](../packages/tour/src/plugin.ts), [`tour/src/processors/gltf.ts`](../packages/tour/src/processors/gltf.ts), [`tour/src/processors/vips.ts`](../packages/tour/src/processors/vips.ts)

**What it means:** Processor "{name}" cannot run: {tool} is not available here

**How to fix:** Cloudflare Workers cannot spawn programs. Use externalProcessor() (a container or server you run) or cloudflareImagesProcessor() in the Worker, and run vipsProcessor()/gltfTransformProcessor() inside that service.

## MIU_E_TOUR_QUEUE_MISSING

- **Package:** `@miujs/tour`
- **HTTP status:** 500
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** Tour assets are processed by queue jobs, but no queue plugin is installed

**How to fix:** Add queue({ jobs: tourPlugin.jobs.all }) from @miujs/queue to miu({ plugins }).

## MIU_E_TOUR_RATE_LIMITED

- **Package:** `@miujs/tour`
- **HTTP status:** 429
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** Too many analytics events

**How to fix:** Batch events (up to 50 per request) and send at most a few requests per minute. Retry after {retryAfter} seconds.

## MIU_E_TOUR_SCENE_NOT_FOUND

- **Package:** `@miujs/tour`
- **HTTP status:** 404
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** Scene {id} not found in this tour

**How to fix:** Use a scene id from GET /tours/:tour (scenes[].id).

## MIU_E_TOUR_SECRET_MISSING

- **Package:** `@miujs/tour`
- **HTTP status:** 500
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** No secret for signing tour links

**How to fix:** Set TOUR_SECRET (32+ random characters; FILES_SECRET or SESSION_SECRET also work), or pass tour({ secret }).

## MIU_E_TOUR_SECRET_WEAK

- **Package:** `@miujs/tour`
- **HTTP status:** 500
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** The tour secret is shorter than 32 characters

**How to fix:** Use 32+ random characters, e.g. `openssl rand -base64 32`.

## MIU_E_TOUR_SLUG_TAKEN

- **Package:** `@miujs/tour`
- **HTTP status:** 409
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** The slug {slug} is already used by another tour

**How to fix:** Pick a different slug, e.g. add the street number or a short suffix.

## MIU_E_TOUR_SOURCE_MISSING

- **Package:** `@miujs/tour`
- **HTTP status:** 404
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** Source file {key} is not in the tour's file store

**How to fix:** Upload it first, and pass the same store to files({ store }) and tour({ store }) so jobs can read what requests stored.

## MIU_E_TOUR_STRICT_CDN

- **Package:** `@miujs/tour`
- **HTTP status:** 500
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** This tour uses privacy: "strict", which forbids third-party CDNs, but the viewer is configured to load from a CDN

**How to fix:** Vendor the viewer files (see the @miujs/tour README, "Self-hosting the viewer"), serve them with staticFiles(), and pass tour({ viewerAssets: { basePath: "/vendor/tour" } }).

## MIU_E_TOUR_TOKEN_EXPIRED

- **Package:** `@miujs/tour`
- **HTTP status:** 403
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** This tour link has expired

**How to fix:** Ask the tour owner for a new share link (POST /tours/:tour/share), or reload the tour page.

## MIU_E_TOUR_TOKEN_INVALID

- **Package:** `@miujs/tour`
- **HTTP status:** 403
- **Source:** [`tour/src/errors.ts`](../packages/tour/src/errors.ts)

**What it means:** Invalid tour token: {why}

**How to fix:** Ask the tour owner for a fresh share link, or open the tour again from its page. Tokens cannot be edited.
