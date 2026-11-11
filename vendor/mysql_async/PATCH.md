Vendored mysql_async 0.37.1 (MIT/Apache-2.0).

Patch: support the `sha256_password` auth plugin on auth switch (src/conn/mod.rs, `sha256_password_auth`).
Over TLS/unix socket the password is sent in clear; otherwise the server RSA public key is requested and the
password XOR scramble is sent RSA-OAEP encrypted (same as libmysqlclient). Remove when upstream supports it.
