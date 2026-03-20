import axios from "axios";
import crypto from "crypto";
import OAuth from "oauth-1.0a";

// e.g. 9511322_SB1 → 9511322-sb1.restlets.api.netsuite.com
const buildRestletUrl = (scriptId: string, deployId: string): string => {
    const accountId = process.env.NS_ACCOUNT_ID;
    if (!accountId) throw new Error("NS_ACCOUNT_ID is not set in .env");
    const accountUrl = accountId.toLowerCase().replace(/_/g, "-");
    return `https://${accountUrl}.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=${scriptId}&deploy=${deployId}`;
};

const buildOAuthHeader = (url: string, method: string): string => {
    const oauth = new OAuth({
        consumer: {
            key: process.env.NS_CONSUMER_KEY!,
            secret: process.env.NS_CONSUMER_SECRET!
        },
        signature_method: "HMAC-SHA256",
        hash_function(baseString: string, key: string) {
            return crypto.createHmac("sha256", key).update(baseString).digest("base64");
        },
        realm: process.env.NS_ACCOUNT_ID!
    });

    const token = {
        key: process.env.NS_TOKEN_ID!,
        secret: process.env.NS_TOKEN_SECRET!
    };

    const authData = oauth.authorize({ url, method, data: {} }, token);
    return oauth.toHeader(authData).Authorization;
};

const post = async (scriptId: string, deployId: string, payload: object): Promise<any> => {
    const url = buildRestletUrl(scriptId, deployId);
    console.log(`[NS Client] POST → ${url}`);

    const authHeader = buildOAuthHeader(url, "POST");

    const response = await axios.post(url, payload, {
        headers: {
            Authorization: authHeader,
            "Content-Type": "application/json"
        }
    });
    console.log(`[NS Client] Response:`, response.data);
    return response.data;
};

// Sales Order restlet
export const postToNetsuite = (payload: object) =>
    post(process.env.RESTLET_SCRIPT_ID!, process.env.RESTLET_DEPLOY_ID!, payload);

// Purchase Order restlet
export const postToNetsuiteForPO = (payload: object) =>
    post(process.env.RESTLET_PO_SCRIPT_ID!, process.env.RESTLET_PO_DEPLOY_ID!, payload);

// Vendor Bill restlet
export const postToNetsuiteForBill = (payload: object) =>
    post(process.env.RESTLET_BILL_SCRIPT_ID!, process.env.RESTLET_BILL_DEPLOY_ID!, payload);

// Diagnostic RESTlet — call with sections to inspect account config
export const callDiagnostic = async (payload: object): Promise<any> => {
    const scriptId = process.env.RESTLET_DIAG_SCRIPT_ID;
    const deployId = process.env.RESTLET_DIAG_DEPLOY_ID;
    if (!scriptId || !deployId) {
        console.error("[DIAG] Missing RESTLET_DIAG_SCRIPT_ID or RESTLET_DIAG_DEPLOY_ID in .env");
        return null;
    }
    return post(scriptId, deployId, payload);
};

// Cleanup RESTlet — lightweight script for deleting POs and test SOs
export const callCleanup = async (payload: object): Promise<any> => {
    const scriptId = process.env.RESTLET_CLEANUP_SCRIPT_ID;
    const deployId = process.env.RESTLET_CLEANUP_DEPLOY_ID;
    if (!scriptId || !deployId) {
        console.error("[CLEANUP] Missing RESTLET_CLEANUP_SCRIPT_ID or RESTLET_CLEANUP_DEPLOY_ID in .env");
        return null;
    }
    return post(scriptId, deployId, payload);
};

// Auth test — sends a minimal ping to the SO restlet
export const testNetsuiteAuth = async (): Promise<void> => {
    try {
        const scriptId = process.env.RESTLET_SCRIPT_ID!;
        const deployId = process.env.RESTLET_DEPLOY_ID!;
        const url = buildRestletUrl(scriptId, deployId);

        console.log(`[AUTH] Testing OAuth → ${url}`);
        const authHeader = buildOAuthHeader(url, "POST");

        const response = await axios.post(url, { action: "ping" }, {
            headers: {
                Authorization: authHeader,
                "Content-Type": "application/json"
            }
        });
        console.log(`[AUTH] ✅ SUCCESS — NetSuite responded:`, response.data);
    } catch (err: any) {
        const data = err.response?.data || err.message;
        console.error(`[AUTH] ❌ FAILED —`, data);
    }
};
