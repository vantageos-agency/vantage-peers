"use node";
/**
 * Gumroad webhook handler for VantagePeers self-host pack auto-delivery.
 *
 * Handles 2 product listings (EN + FR) for the same logical product.
 * On a successful sale:
 *   1. Verifies Gumroad HMAC-SHA256 signature.
 *   2. Whitelists product_id against EN/FR env vars.
 *   3. Idempotency check via gumroadOrderId.
 *   4. Generates license via internal mutation (no master token required here).
 *   5. Sends onboarding email (EN or FR) via Resend.
 *   6. Returns 200 with { ok, licenseId, emailSent }.
 *
 * Environment variables required:
 *   GUMROAD_WEBHOOK_SECRET      — HMAC secret set in Gumroad product settings
 *   GUMROAD_PRODUCT_ID_EN       — Gumroad product permalink/id for EN listing
 *   GUMROAD_PRODUCT_ID_FR       — Gumroad product permalink/id for FR listing
 *   RESEND_API_KEY              — Resend API key for transactional email
 *   RESEND_FROM                 — Sender address, e.g. "VantagePeers <noreply@vantagepeers.com>"
 *   CEDRIC_CALENDAR_URL         — (optional) Google Calendar booking URL for Cédric
 */

import { createHmac } from "node:crypto";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DOC_URL_EN =
	"https://github.com/vantageos-agency/vantage-peers/blob/main/docs/install-EN.md";
const DOC_URL_FR =
	"https://github.com/vantageos-agency/vantage-peers/blob/main/docs/install-FR.md";

// TODO(pi/laurent): replace with Cédric's actual GitHub repos once known.
// These can be populated via env vars or an admin tool.
const PLACEHOLDER_REPOS = [
	"https://github.com/placeholder/repo-1",
	"https://github.com/placeholder/repo-2",
	"https://github.com/placeholder/repo-3",
	"https://github.com/placeholder/repo-4",
	"https://github.com/placeholder/repo-5",
];

const UNSUBSCRIBE_URL = "https://vantagepeers.com/unsubscribe";
const PRIVACY_POLICY_URL = "https://vantagepeers.com/privacy";
const COMPANY_ADDRESS = "VantageOS — 75008 Paris, France";

// ─────────────────────────────────────────────────────────────────────────────
// Email templates (embedded — avoids fs dependency in action bundle)
// ─────────────────────────────────────────────────────────────────────────────

const TEMPLATE_EN_TXT = `Subject: Welcome to VantagePeers, {{CUSTOMER_NAME}}

========================================
VANTAGEPEERS — SELF-HOST ONBOARDING PACK
========================================

Welcome, {{CUSTOMER_NAME}}.

Thank you for choosing VantagePeers. Your open-core self-host licence is
now active and everything you need to get started is in this email.

We have scheduled 3 onboarding sessions of 30 minutes each:
  - Session 1: Configure your environment
  - Session 2: Review your GitHub repositories together
  - Session 3: Close open questions before you go live

Use the calendar link below to lock in times that suit you.


----------------------------------------
YOUR LICENSE KEY
----------------------------------------

{{LICENSE_KEY}}

Keep this key secure. It is tied to your account and required for every
installation.


----------------------------------------
INSTALLATION DOCUMENTATION
----------------------------------------

Start with the English guide:
{{DOC_URL_EN}}

A French version is also available if useful for your team:
{{DOC_URL_FR}}


----------------------------------------
BOOK YOUR 3 ONBOARDING SESSIONS
----------------------------------------

Sessions are 30 minutes each and can be spread across days or weeks —
your pace.

Book your 3 sessions here:
{{CALENDAR_URL}}

(Link opens Google Calendar. No account required to view available slots.)


----------------------------------------
YOUR GITHUB REPOSITORIES (SESSION 2 AGENDA)
----------------------------------------

In session 2 we will walk through your repositories together.
We have pre-loaded the following:

  * {{GITHUB_REPO_1}}
  * {{GITHUB_REPO_2}}
  * {{GITHUB_REPO_3}}
  * {{GITHUB_REPO_4}}
  * {{GITHUB_REPO_5}}

We will review these together in session 2. If this list needs updating,
reply to this email before our first session.


----------------------------------------
DIRECT SUPPORT
----------------------------------------

For any question outside of sessions, reach Laurent Perello directly at:
lp@perello.consulting

Expect a reply within one business day.


----------------------------------------

Pi & the orchestrators team
VantageOS — VantagePeers


========================================
LEGAL FOOTER
========================================

This is a transactional email sent because you purchased a VantagePeers
licence. Even so, you may unsubscribe from non-transactional
communications here: {{UNSUBSCRIBE_URL}}

Your data is processed in accordance with our Privacy Policy
({{PRIVACY_POLICY_URL}}) and GDPR Article 6(1)(b) (performance of a
contract). Data controller: VantageOS.

{{COMPANY_ADDRESS}}`;

const TEMPLATE_FR_TXT = `Objet : Bienvenue chez VantagePeers, {{CUSTOMER_NAME}}

========================================
VANTAGEPEERS — PACK D'ONBOARDING SELF-HOST
========================================

Cher {{CUSTOMER_NAME}},

Nous avons le plaisir de vous accueillir chez VantagePeers. Votre licence
open-core self-host est desormais active et vous trouverez ci-dessous tout
ce dont vous avez besoin pour demarrer.

Nous avons prevu 3 sessions d'onboarding de 30 minutes chacune :
  - Session 1 : Configuration de votre environnement
  - Session 2 : Revue de vos depots GitHub ensemble
  - Session 3 : Reponse a vos dernieres questions avant la mise en production

Utilisez le lien de calendrier ci-dessous pour choisir les creneaux qui
vous conviennent.


----------------------------------------
VOTRE CLE DE LICENCE
----------------------------------------

{{LICENSE_KEY}}

Conservez cette cle en lieu sur. Elle est liee a votre compte et requise
pour chaque installation.


----------------------------------------
DOCUMENTATION D'INSTALLATION
----------------------------------------

Vous trouverez ci-dessous le guide en francais :
{{DOC_URL_FR}}

Une version en anglais est egalement disponible pour votre equipe si besoin :
{{DOC_URL_EN}}


----------------------------------------
RESERVER VOS 3 SESSIONS D'ONBOARDING
----------------------------------------

Les sessions sont de 30 minutes chacune et peuvent etre reparties sur
plusieurs jours ou semaines, selon vos disponibilites.

Reserver vos 3 sessions :
{{CALENDAR_URL}}

(Le lien ouvre Google Calendar. Aucun compte requis pour consulter les
creneaux disponibles.)


----------------------------------------
VOS DEPOTS GITHUB (PROGRAMME DE LA SESSION 2)
----------------------------------------

Lors de la session 2, nous parcourrons ensemble vos depots.
Nous avons pre-enregistre les suivants :

  * {{GITHUB_REPO_1}}
  * {{GITHUB_REPO_2}}
  * {{GITHUB_REPO_3}}
  * {{GITHUB_REPO_4}}
  * {{GITHUB_REPO_5}}

Nous passerons en revue ces depots lors de la session 2. Si cette liste
necessite des ajustements, repondez a cet email avant notre premiere
session.


----------------------------------------
CONTACT DIRECT
----------------------------------------

Pour toute question en dehors des sessions, vous pouvez contacter Laurent
Perello directement a l'adresse :
lp@perello.consulting

Comptez une reponse sous un jour ouvre.


----------------------------------------

Pi & l'equipe des orchestrateurs
VantageOS — VantagePeers


========================================
MENTIONS LEGALES
========================================

Cet email transactionnel vous est adresse en raison de votre achat d'une
licence VantagePeers. Vous pouvez neanmoins vous desabonner des
communications non transactionnelles ici : {{UNSUBSCRIBE_URL}}

Vos donnees sont traitees conformement a notre Politique de confidentialite
({{PRIVACY_POLICY_URL}}) et a l'article 6(1)(b) du RGPD (execution d'un
contrat). Responsable du traitement : VantageOS.

{{COMPANY_ADDRESS}}`;

// HTML templates — imported as string literals from the W4 design.
const TEMPLATE_EN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>Welcome to VantagePeers, {{CUSTOMER_NAME}}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;color:#f4f4f4;font-size:1px;">
    Your VantagePeers onboarding pack is ready &mdash; license key, install docs, and 3 sessions to get you running.
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f4;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
               style="max-width:600px;width:100%;background-color:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
          <tr>
            <td style="background-color:#0f172a;padding:28px 36px;">
              <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">VantagePeers</p>
              <p style="margin:4px 0 0;font-size:13px;color:#94a3b8;letter-spacing:0.4px;text-transform:uppercase;">Self-Host Onboarding Pack</p>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 36px 24px;">
              <p style="margin:0 0 20px;font-size:17px;font-weight:600;color:#0f172a;">Welcome, {{CUSTOMER_NAME}}.</p>
              <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#334155;">
                Thank you for choosing VantagePeers. Your open-core self-host licence is now active.
              </p>
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 28px;" />
              <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.6px;">Your License Key</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background-color:#f1f5f9;border:1px solid #cbd5e1;border-radius:4px;padding:16px 20px;">
                    <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:15px;font-weight:700;color:#0f172a;letter-spacing:0.05em;word-break:break-all;">{{LICENSE_KEY}}</p>
                  </td>
                </tr>
              </table>
              <p style="margin:8px 0 28px;font-size:12px;color:#64748b;">Keep this key secure. It is tied to your account and required for every installation.</p>
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 28px;" />
              <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.6px;">Installation Documentation</p>
              <p style="margin:0 0 8px;font-size:15px;"><a href="{{DOC_URL_EN}}" style="color:#2563eb;text-decoration:underline;font-weight:600;">VantagePeers Install Guide (EN) &rarr;</a></p>
              <p style="margin:0 0 28px;font-size:15px;"><a href="{{DOC_URL_FR}}" style="color:#2563eb;text-decoration:underline;">Guide d'installation VantagePeers (FR) &rarr;</a></p>
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 28px;" />
              <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.6px;">Book Your 3 Onboarding Sessions</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background-color:#0f172a;border-radius:4px;padding:12px 24px;">
                    <a href="{{CALENDAR_URL}}" style="font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;display:inline-block;">Book your 3 sessions &rarr;</a>
                  </td>
                </tr>
              </table>
              <p style="margin:8px 0 28px;font-size:12px;color:#64748b;">Link opens Google Calendar.</p>
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 28px;" />
              <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.6px;">Your GitHub Repositories (Session 2 Agenda)</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;">
                <tr><td style="padding:16px 20px;">
                  <p style="margin:4px 0;font-size:14px;color:#334155;">&bull;&nbsp;<a href="{{GITHUB_REPO_1}}" style="color:#2563eb;">{{GITHUB_REPO_1}}</a></p>
                  <p style="margin:4px 0;font-size:14px;color:#334155;">&bull;&nbsp;<a href="{{GITHUB_REPO_2}}" style="color:#2563eb;">{{GITHUB_REPO_2}}</a></p>
                  <p style="margin:4px 0;font-size:14px;color:#334155;">&bull;&nbsp;<a href="{{GITHUB_REPO_3}}" style="color:#2563eb;">{{GITHUB_REPO_3}}</a></p>
                  <p style="margin:4px 0;font-size:14px;color:#334155;">&bull;&nbsp;<a href="{{GITHUB_REPO_4}}" style="color:#2563eb;">{{GITHUB_REPO_4}}</a></p>
                  <p style="margin:4px 0;font-size:14px;color:#334155;">&bull;&nbsp;<a href="{{GITHUB_REPO_5}}" style="color:#2563eb;">{{GITHUB_REPO_5}}</a></p>
                </td></tr>
              </table>
              <p style="margin:8px 0 28px;font-size:12px;color:#64748b;">Reply to this email if this list needs updating before session 2.</p>
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 28px;" />
              <p style="margin:0 0 28px;font-size:15px;line-height:1.7;color:#334155;">
                For any question outside of sessions, reach Laurent Perello directly at
                <a href="mailto:lp@perello.consulting" style="color:#2563eb;font-weight:600;">lp@perello.consulting</a>.
              </p>
              <p style="margin:0 0 4px;font-size:15px;color:#0f172a;font-weight:600;">Pi &amp; the orchestrators team</p>
              <p style="margin:0 0 28px;font-size:14px;color:#64748b;">VantageOS &mdash; VantagePeers</p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 36px;">
              <p style="margin:0 0 6px;font-size:11px;color:#94a3b8;line-height:1.6;">
                This is a transactional email. You may <a href="{{UNSUBSCRIBE_URL}}" style="color:#64748b;">unsubscribe from non-transactional communications here</a>.
              </p>
              <p style="margin:0 0 6px;font-size:11px;color:#94a3b8;line-height:1.6;">
                Your data is processed per our <a href="{{PRIVACY_POLICY_URL}}" style="color:#64748b;">Privacy Policy</a> and GDPR Art. 6(1)(b). Data controller: VantageOS.
              </p>
              <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.6;">{{COMPANY_ADDRESS}}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

const TEMPLATE_FR_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>Bienvenue chez VantagePeers, {{CUSTOMER_NAME}}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;color:#f4f4f4;font-size:1px;">
    Votre pack d'onboarding VantagePeers est pret &mdash; cle de licence, documentation et 3 sessions pour demarrer.
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f4;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
               style="max-width:600px;width:100%;background-color:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
          <tr>
            <td style="background-color:#0f172a;padding:28px 36px;">
              <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">VantagePeers</p>
              <p style="margin:4px 0 0;font-size:13px;color:#94a3b8;letter-spacing:0.4px;text-transform:uppercase;">Pack d'onboarding Self-Host</p>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 36px 24px;">
              <p style="margin:0 0 20px;font-size:17px;font-weight:600;color:#0f172a;">Cher {{CUSTOMER_NAME}},</p>
              <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#334155;">
                Nous avons le plaisir de vous accueillir chez VantagePeers. Votre licence open-core self-host est desormais active.
              </p>
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 28px;" />
              <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.6px;">Votre cle de licence</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background-color:#f1f5f9;border:1px solid #cbd5e1;border-radius:4px;padding:16px 20px;">
                    <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:15px;font-weight:700;color:#0f172a;letter-spacing:0.05em;word-break:break-all;">{{LICENSE_KEY}}</p>
                  </td>
                </tr>
              </table>
              <p style="margin:8px 0 28px;font-size:12px;color:#64748b;">Conservez cette cle en lieu sur. Elle est liee a votre compte et requise pour chaque installation.</p>
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 28px;" />
              <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.6px;">Documentation d'installation</p>
              <p style="margin:0 0 8px;font-size:15px;"><a href="{{DOC_URL_FR}}" style="color:#2563eb;text-decoration:underline;font-weight:600;">Guide d'installation VantagePeers (FR) &rarr;</a></p>
              <p style="margin:0 0 28px;font-size:15px;"><a href="{{DOC_URL_EN}}" style="color:#2563eb;text-decoration:underline;">VantagePeers Install Guide (EN) &rarr;</a></p>
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 28px;" />
              <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.6px;">Reserver vos 3 sessions d'onboarding</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background-color:#0f172a;border-radius:4px;padding:12px 24px;">
                    <a href="{{CALENDAR_URL}}" style="font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;display:inline-block;">Reserver vos 3 sessions &rarr;</a>
                  </td>
                </tr>
              </table>
              <p style="margin:8px 0 28px;font-size:12px;color:#64748b;">Le lien ouvre Google Calendar.</p>
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 28px;" />
              <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.6px;">Vos depots GitHub (programme de la session 2)</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;">
                <tr><td style="padding:16px 20px;">
                  <p style="margin:4px 0;font-size:14px;color:#334155;">&bull;&nbsp;<a href="{{GITHUB_REPO_1}}" style="color:#2563eb;">{{GITHUB_REPO_1}}</a></p>
                  <p style="margin:4px 0;font-size:14px;color:#334155;">&bull;&nbsp;<a href="{{GITHUB_REPO_2}}" style="color:#2563eb;">{{GITHUB_REPO_2}}</a></p>
                  <p style="margin:4px 0;font-size:14px;color:#334155;">&bull;&nbsp;<a href="{{GITHUB_REPO_3}}" style="color:#2563eb;">{{GITHUB_REPO_3}}</a></p>
                  <p style="margin:4px 0;font-size:14px;color:#334155;">&bull;&nbsp;<a href="{{GITHUB_REPO_4}}" style="color:#2563eb;">{{GITHUB_REPO_4}}</a></p>
                  <p style="margin:4px 0;font-size:14px;color:#334155;">&bull;&nbsp;<a href="{{GITHUB_REPO_5}}" style="color:#2563eb;">{{GITHUB_REPO_5}}</a></p>
                </td></tr>
              </table>
              <p style="margin:8px 0 28px;font-size:12px;color:#64748b;">Repondez a cet email si cette liste necessite des ajustements avant la session 2.</p>
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 28px;" />
              <p style="margin:0 0 28px;font-size:15px;line-height:1.7;color:#334155;">
                Pour toute question, contactez Laurent Perello a
                <a href="mailto:lp@perello.consulting" style="color:#2563eb;font-weight:600;">lp@perello.consulting</a>.
              </p>
              <p style="margin:0 0 4px;font-size:15px;color:#0f172a;font-weight:600;">Pi &amp; l'equipe des orchestrateurs</p>
              <p style="margin:0 0 28px;font-size:14px;color:#64748b;">VantageOS &mdash; VantagePeers</p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 36px;">
              <p style="margin:0 0 6px;font-size:11px;color:#94a3b8;line-height:1.6;">
                Email transactionnel. <a href="{{UNSUBSCRIBE_URL}}" style="color:#64748b;">Se desabonner des communications non transactionnelles</a>.
              </p>
              <p style="margin:0 0 6px;font-size:11px;color:#94a3b8;line-height:1.6;">
                Donnees traitees per notre <a href="{{PRIVACY_POLICY_URL}}" style="color:#64748b;">Politique de confidentialite</a> et RGPD Art. 6(1)(b). Responsable : VantageOS.
              </p>
              <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.6;">{{COMPANY_ADDRESS}}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

// ─────────────────────────────────────────────────────────────────────────────
// Template substitution helper
// ─────────────────────────────────────────────────────────────────────────────

function fillTemplate(template: string, vars: Record<string, string>): string {
	let result = template;
	for (const [key, value] of Object.entries(vars)) {
		// Replace all occurrences of {{KEY}}
		result = result.split(`{{${key}}}`).join(value);
	}
	return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gumroad signature verification
// Gumroad signs with HMAC-SHA256 and sends the hex digest in the
// "X-Gumroad-Signature" header.
// ─────────────────────────────────────────────────────────────────────────────

function verifyGumroadSignature(
	body: string,
	signature: string,
	secret: string,
): boolean {
	const expected = createHmac("sha256", secret).update(body).digest("hex");
	// Constant-time comparison using Buffer.from to avoid timing attacks
	const sigBuf = Buffer.from(signature);
	const expBuf = Buffer.from(expected);
	if (sigBuf.length !== expBuf.length) return false;
	let diff = 0;
	for (let i = 0; i < sigBuf.length; i++) {
		diff |= sigBuf[i] ^ expBuf[i];
	}
	return diff === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resend email send helper
// ─────────────────────────────────────────────────────────────────────────────

async function sendViaResend(params: {
	to: string;
	subject: string;
	html: string;
	text: string;
}): Promise<{ ok: boolean; error?: string }> {
	const apiKey = process.env.RESEND_API_KEY;
	const from =
		process.env.RESEND_FROM ?? "VantagePeers <noreply@vantagepeers.com>";

	if (!apiKey) {
		return { ok: false, error: "RESEND_API_KEY not configured" };
	}

	try {
		const res = await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				from,
				to: [params.to],
				subject: params.subject,
				html: params.html,
				text: params.text,
			}),
		});

		if (!res.ok) {
			const body = await res.text();
			return { ok: false, error: `Resend HTTP ${res.status}: ${body}` };
		}

		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// handleGumroadWebhook — internal action called from http.ts
// ─────────────────────────────────────────────────────────────────────────────

export const handleGumroadWebhook = internalAction({
	args: {
		body: v.string(),
		signature: v.union(v.string(), v.null()),
	},
	returns: v.object({
		status: v.number(),
		payload: v.string(),
	}),
	handler: async (ctx, args): Promise<{ status: number; payload: string }> => {
		// ── 1. Signature verification ────────────────────────────────────────────
		const webhookSecret = process.env.GUMROAD_WEBHOOK_SECRET;
		if (!webhookSecret) {
			console.error("[gumroad-webhook] GUMROAD_WEBHOOK_SECRET not set");
			return {
				status: 500,
				payload: JSON.stringify({ error: "Server misconfiguration" }),
			};
		}

		if (!args.signature) {
			console.error("[gumroad-webhook] Missing X-Gumroad-Signature header");
			return {
				status: 401,
				payload: JSON.stringify({ error: "Missing signature" }),
			};
		}

		const signatureValid = verifyGumroadSignature(
			args.body,
			args.signature,
			webhookSecret,
		);
		if (!signatureValid) {
			console.error("[gumroad-webhook] Invalid HMAC signature — rejecting");
			return {
				status: 401,
				payload: JSON.stringify({ error: "Invalid signature" }),
			};
		}

		// ── 2. Parse Gumroad payload (form-encoded) ──────────────────────────────
		// Gumroad sends application/x-www-form-urlencoded
		let params: URLSearchParams;
		try {
			params = new URLSearchParams(args.body);
		} catch {
			return {
				status: 400,
				payload: JSON.stringify({ error: "Invalid form body" }),
			};
		}

		const productId =
			params.get("product_id") ?? params.get("product_permalink") ?? "";
		const gumroadOrderId =
			params.get("sale_id") ?? params.get("order_id") ?? "";
		const customerEmail = params.get("email") ?? "";
		const customerName =
			params.get("full_name") ?? params.get("buyer_name") ?? undefined;

		if (!customerEmail) {
			return {
				status: 400,
				payload: JSON.stringify({ error: "Missing email in payload" }),
			};
		}

		// ── 3. Whitelist product_id → derive locale ──────────────────────────────
		const productIdEn = process.env.GUMROAD_PRODUCT_ID_EN ?? "";
		const productIdFr = process.env.GUMROAD_PRODUCT_ID_FR ?? "";

		let purchaseLocale: "en" | "fr";
		if (productId === productIdEn) {
			purchaseLocale = "en";
		} else if (productId === productIdFr) {
			purchaseLocale = "fr";
		} else {
			console.error(
				`[gumroad-webhook] Non-whitelisted product_id: "${productId}" — ALERT: possible misconfiguration or fraud`,
			);
			return {
				status: 400,
				payload: JSON.stringify({ error: "Product not authorized" }),
			};
		}

		// ── 4. Idempotency: check if this order already has a license ─────────────
		if (gumroadOrderId) {
			const existing: {
				licenseId: string;
				customerEmail: string;
				emailSent?: boolean;
			} | null = await ctx.runMutation(internal.licenses.getByGumroadOrderId, {
				gumroadOrderId,
			});

			if (existing !== null) {
				console.log(
					`[gumroad-webhook] Duplicate sale_id "${gumroadOrderId}" — returning existing license ${existing.licenseId}`,
				);
				return {
					status: 200,
					payload: JSON.stringify({
						ok: true,
						licenseId: existing.licenseId,
						emailSent: existing.emailSent ?? false,
						duplicate: true,
					}),
				};
			}
		}

		// ── 5. Generate license (internal — no master token needed) ───────────────
		let licenseKey: string;
		let licenseId: string;
		try {
			const result: {
				licenseKey: string;
				licenseId: string;
				expiresAt: number;
			} = await ctx.runMutation(internal.licenses.generateInternal, {
				customerEmail,
				customerName: customerName ?? undefined,
				productCode: "vantage-peers-self-host",
				tier: "open-core-99-eur-yr",
				purchaseLocale,
				gumroadOrderId: gumroadOrderId || undefined,
				expiresInDays: 365,
			});
			licenseKey = result.licenseKey;
			licenseId = result.licenseId;
		} catch (err) {
			console.error("[gumroad-webhook] License generation failed:", err);
			return {
				status: 500,
				payload: JSON.stringify({
					error: `License generation failed: ${err instanceof Error ? err.message : String(err)}`,
				}),
			};
		}

		// ── 6. Build and send onboarding email ────────────────────────────────────
		// CALENDAR_URL: set CEDRIC_CALENDAR_URL env var in prod.
		// Fallback to placeholder if not configured.
		const calendarUrl =
			process.env.CEDRIC_CALENDAR_URL ??
			"https://calendar.app.google/PLACEHOLDER"; // Pi/Laurent: set CEDRIC_CALENDAR_URL in Convex dashboard

		const displayName = customerName ?? customerEmail;

		const templateVars: Record<string, string> = {
			CUSTOMER_NAME: displayName,
			LICENSE_KEY: licenseKey,
			DOC_URL_EN,
			DOC_URL_FR,
			CALENDAR_URL: calendarUrl,
			GITHUB_REPO_1: PLACEHOLDER_REPOS[0],
			GITHUB_REPO_2: PLACEHOLDER_REPOS[1],
			GITHUB_REPO_3: PLACEHOLDER_REPOS[2],
			GITHUB_REPO_4: PLACEHOLDER_REPOS[3],
			GITHUB_REPO_5: PLACEHOLDER_REPOS[4],
			UNSUBSCRIBE_URL,
			PRIVACY_POLICY_URL,
			COMPANY_ADDRESS,
		};

		const isEn = purchaseLocale === "en";
		const subjectLine = isEn
			? `Welcome to VantagePeers, ${displayName}`
			: `Bienvenue chez VantagePeers, ${displayName}`;

		const emailHtml = fillTemplate(
			isEn ? TEMPLATE_EN_HTML : TEMPLATE_FR_HTML,
			templateVars,
		);
		const emailText = fillTemplate(
			isEn ? TEMPLATE_EN_TXT : TEMPLATE_FR_TXT,
			templateVars,
		);

		const emailResult = await sendViaResend({
			to: customerEmail,
			subject: subjectLine,
			html: emailHtml,
			text: emailText,
		});

		// Flag email delivery on the license row regardless of outcome
		await ctx.runMutation(internal.licenses.flagEmailSent, {
			// licenseId is typed as Id<"licenses"> in the mutation; the string returned
			// by generateInternal is that same branded type at runtime.
			licenseId: licenseId as string & { __tableName: "licenses" },
			emailSent: emailResult.ok,
		});

		if (!emailResult.ok) {
			// Email failed → log error but DO NOT return 500 (license was generated).
			// The emailSent=false flag on the license row enables a retry queue later.
			console.error(
				`[gumroad-webhook] Email send failed for ${customerEmail}: ${emailResult.error}. License ${licenseId} generated. Flag emailSent=false for retry.`,
			);
		}

		return {
			status: 200,
			payload: JSON.stringify({
				ok: true,
				licenseId,
				emailSent: emailResult.ok,
			}),
		};
	},
});
