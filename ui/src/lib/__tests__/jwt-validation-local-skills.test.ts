/**
 * @jest-environment node
 */

import { SignJWT, decodeJwt } from 'jose';

import {
  LOCAL_SKILLS_TOKEN_AUDIENCE,
  LOCAL_SKILLS_TOKEN_ISSUER,
  LocalSkillsJWTValidationError,
  signLocalSkillsToken,
  validateLocalSkillsJWT,
} from '../jwt-validation';

const TEST_SECRET = 'local-skills-test-secret-that-is-long-enough';

async function signClaims(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(LOCAL_SKILLS_TOKEN_ISSUER)
    .setAudience(LOCAL_SKILLS_TOKEN_AUDIENCE)
    .setSubject('owner-sub')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(TEST_SECRET));
}

describe('local skills JWT authorization claims', () => {
  beforeEach(() => {
    process.env.SKILLS_API_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    delete process.env.SKILLS_API_SECRET;
  });

  it('signs and preserves the constrained token type, scope, issuer, and audience', async () => {
    const token = await signLocalSkillsToken('owner@example.com', 'Owner', '1d', 'owner-sub');
    const claims = decodeJwt(token);

    expect(claims).toMatchObject({
      type: 'skills_api_key',
      scope: 'skills:read',
      iss: LOCAL_SKILLS_TOKEN_ISSUER,
      aud: LOCAL_SKILLS_TOKEN_AUDIENCE,
      sub: 'owner-sub',
    });

    await expect(validateLocalSkillsJWT(token)).resolves.toMatchObject({
      email: 'owner@example.com',
      sub: 'owner-sub',
      tokenType: 'skills_api_key',
      scopes: ['skills:read'],
      issuer: LOCAL_SKILLS_TOKEN_ISSUER,
      audience: LOCAL_SKILLS_TOKEN_AUDIENCE,
    });
  });

  it('rejects a signed local token without the skills:read scope', async () => {
    const token = await signClaims({
      email: 'owner@example.com',
      name: 'Owner',
      type: 'skills_api_key',
      scope: 'admin:write',
    });

    await expect(validateLocalSkillsJWT(token)).rejects.toBeInstanceOf(
      LocalSkillsJWTValidationError,
    );
  });

  it('rejects a signed local token with the wrong audience', async () => {
    const token = await new SignJWT({
      email: 'owner@example.com',
      name: 'Owner',
      type: 'skills_api_key',
      scope: 'skills:read',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(LOCAL_SKILLS_TOKEN_ISSUER)
      .setAudience('another-api')
      .setSubject('owner-sub')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(TEST_SECRET));

    await expect(validateLocalSkillsJWT(token)).rejects.toBeInstanceOf(
      LocalSkillsJWTValidationError,
    );
  });
});
