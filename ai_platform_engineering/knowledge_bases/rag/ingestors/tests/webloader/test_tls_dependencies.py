"""Regression tests for Scrapy/Twisted TLS dependency compatibility."""

from OpenSSL import SSL
from twisted.internet._sslverify import ClientTLSOptions


def test_twisted_client_tls_options_accepts_pyopenssl_connection_factory():
  """Twisted TLS setup should work with the locked PyOpenSSL dependency."""
  context = SSL.Context(SSL.TLS_METHOD)

  options = ClientTLSOptions(lambda _protocol: SSL.Connection(context, None), "example.com")

  assert options is not None
