# Agent Note: Explicit GitHub account binding

Status: implemented

## Problem

Users need GitHub sign-in without bypassing invitation-based onboarding or accidentally merging tenant accounts by email.

## Decision

Existing users bind GitHub from personal account settings after confirming their current password. GitHub sign-in resolves only the immutable numeric GitHub ID with a unique nullable tenant column; it never creates users or links by email or username. Unlinking verifies the current password, clears the mapping, and increments the session password version while reissuing the current browser session.

OAuth uses an encrypted HttpOnly SameSite=Lax cookie containing a ten-minute state and PKCE verifier, plus the original session fingerprint and password version for binding. GitHub's single-use authorization code and PKCE prevent callback replay; the cookie is cleared on callback. Bind commits conditionally on enabled, unexpired, unchanged-password, unbound tenants. A unique database index arbitrates concurrent cross-tenant attempts. Only public GitHub identity is requested, and neither access nor refresh tokens are persisted. Client credentials are environment configuration, never shipped to the frontend.

## Alternatives considered

Automatic email linking could take over existing accounts and would change invitation semantics. A separate external identity table is unnecessary for one optional provider per tenant. Persisting GitHub access tokens is unnecessary for login and would add a credential lifecycle. An in-memory OAuth state registry would break callbacks across replicas or restarts; encrypted cookies and provider-enforced single-use codes work across replicas sharing encryption keys.

## Consequences

Users must retain their local password for binding and unlinking. GitHub authorization alone does not grant administrator status, extend expiry, or enable disabled tenants. Startup AutoMigrate adds the nullable unique ID and display-login columns. Deployments must configure both GitHub credentials and an exact public callback origin; source changes alone do not enable production login. Store integration tests require TEST_DATABASE_URL. No live tenant is automatically bound during development.
