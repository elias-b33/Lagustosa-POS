/** Public browser configuration must never contain a privileged server credential. */
export function validatePublicConfig(
  url?: string,
  key?: string,
  required = false,
  development = false,
) {
  if (!url && !key && !required) return;
  let publicKey = /^sb_publishable_[A-Za-z0-9_-]+$/.test(key ?? "");
  if (key?.split(".").length === 3) {
    try {
      publicKey =
        JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString())
          .role === "anon";
    } catch {
      publicKey = false;
    }
  }
  let address: URL | undefined;
  try {
    address = new URL(url ?? "");
  } catch {
    /* Report configuration without echoing its contents. */
  }
  const secure =
    address?.protocol === "https:" ||
    (development &&
      address?.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(address.hostname));
  if (
    !address ||
    !secure ||
    address.username ||
    address.password ||
    address.search ||
    address.hash ||
    address.pathname !== "/" ||
    !publicKey
  )
    throw new Error(
      "Admin kräver projektets HTTPS-adress och en publishable/anon-nyckel. Hemliga servernycklar får aldrig byggas in i webbappen.",
    );
}
