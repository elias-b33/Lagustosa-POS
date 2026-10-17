import { createClient } from "@supabase/supabase-js";
const url = import.meta.env.VITE_ADMIN_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_ADMIN_SUPABASE_KEY as string | undefined;
export const cloud = url && key ? createClient(url, key) : null;
export const local = !cloud;
const base = cloud ? `${url}/functions/v1/admin-api` : "/api";
export async function api<T>(
  route: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (cloud) {
    const { data } = await cloud.auth.getSession();
    if (data.session)
      headers.set("Authorization", `Bearer ${data.session.access_token}`);
    headers.set("apikey", key!);
  }
  const response = await fetch(base + route, {
    ...options,
    headers,
    credentials: cloud ? "omit" : "same-origin",
  });
  if (!response.ok) {
    const body = await response
      .json()
      .catch(() => ({ message: "Anslutningen kunde inte nås." }));
    throw Object.assign(
      new Error(body.message ?? "Uppgifterna kunde inte hämtas."),
      { status: response.status },
    );
  }
  return response.json();
}
export type Session = {
  email: string;
  verified: boolean;
  enrolled: boolean;
  local: boolean;
  mfaRequired?: boolean;
  factors?: { id: string; name: string }[];
};
export async function session(): Promise<Session | null> {
  if (!cloud) {
    try {
      return await api<Session>("/auth/session");
    } catch {
      return null;
    }
  }
  const {
    data: { user },
  } = await cloud.auth.getUser();
  if (!user) return null;
  const { data: levels } =
    await cloud.auth.mfa.getAuthenticatorAssuranceLevel();
  const { data: factors } = await cloud.auth.mfa.listFactors();
  return {
    email: user.email ?? "",
    verified: levels?.currentLevel === "aal2",
    enrolled: Boolean(factors?.totp.length),
    local: false,
    mfaRequired: true,
    factors: (factors?.totp ?? []).map((factor) => ({
      id: factor.id,
      name: factor.friendly_name ?? "Google Authenticator",
    })),
  };
}
export async function signIn(email: string, password: string) {
  if (!cloud)
    return api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  const { error } = await cloud.auth.signInWithPassword({ email, password });
  if (error) throw error;
}
export type Enrollment = { qr: string; secret: string; factorId?: string };
export async function enroll(password?: string): Promise<Enrollment> {
  if (!cloud)
    return api<Enrollment>("/auth/enroll", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  const { data, error } = await cloud.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `Eleva Admin · ${new Date().toISOString()}`,
  });
  if (error) throw error;
  return { qr: data.totp.qr_code, secret: data.totp.secret, factorId: data.id };
}
export async function cancelEnrollment(factorId?: string) {
  if (!cloud) return api("/auth/enroll/cancel", { method: "POST", body: "{}" });
  if (!factorId) return;
  const { data, error } = await cloud.auth.mfa.listFactors();
  if (error) throw error;
  // Never remove a verified factor, or another browser's pending setup.
  if (
    data.all.some(
      (factor) => factor.id === factorId && factor.status === "unverified",
    )
  ) {
    const { error } = await cloud.auth.mfa.unenroll({ factorId });
    if (error) throw error;
  }
}
export async function verify(code: string, factorId?: string) {
  if (!cloud)
    return api("/auth/verify", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  if (!factorId) {
    const { data, error } = await cloud.auth.mfa.listFactors();
    if (error) throw error;
    factorId = data?.totp[0]?.id;
  }
  if (!factorId) throw new Error("Koppla Google Authenticator först.");
  const { error } = await cloud.auth.mfa.challengeAndVerify({
    factorId,
    code,
  });
  if (error) throw error;
}
export async function signOut() {
  if (cloud) {
    const { error } = await cloud.auth.signOut();
    if (error) throw error;
  } else await api("/auth/logout", { method: "POST", body: "{}" });
}
export async function resetPassword(email: string) {
  if (!cloud)
    throw new Error(
      "Det lokala testkontot finns i inloggning.txt på kassadatorn. E-poståterställning används i den publicerade portalen.",
    );
  const { error } = await cloud.auth.resetPasswordForEmail(email, {
    redirectTo: location.origin + "/account",
  });
  if (error) throw error;
}
export async function newPassword(password: string) {
  if (!cloud) throw new Error("Det lokala testkontot hanteras på datorn.");
  const { error } = await cloud.auth.updateUser({ password });
  if (error) throw error;
}
export async function download(query: URLSearchParams) {
  const headers: Record<string, string> = {};
  if (cloud) {
    const { data } = await cloud.auth.getSession();
    headers.Authorization = `Bearer ${data.session?.access_token ?? ""}`;
    headers.apikey = key!;
  }
  const response = await fetch(base + "/export?" + query, {
    headers,
    credentials: cloud ? "omit" : "same-origin",
  });
  if (!response.ok) throw new Error("Exporten kunde inte hämtas.");
  const object = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = object;
  link.download = `eleva-statistik-${query.get("from")}-${query.get("to")}-test.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(object), 1000);
}
