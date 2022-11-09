export const encryption = true;
const referenceText = 'OpenMRS';
const passwordExpiryHours = 8;

const ENCRYPTION_CONTENT_KEY = "content";
const ENCRYPTION_NONCE_KEY = "nonce";
const ENCRYPTED_REFERENCE_KEY = "encryptedReference";
const ENCRYPTED_KEY_CREATION_TIME_KEY = "encryptedKeyCreationTime";
const TIME_ONE_HOUR = 3600000;

class EncryptionKey {
  key: CryptoKey
};

var encryptionKey: EncryptionKey = new EncryptionKey(); 

function getEncryptedReference() {
  return localStorage.getItem(ENCRYPTED_REFERENCE_KEY);
}

async function setEncryptedReference(key: CryptoKey) {
  let encryptedRef = await encryptData(referenceText, key);
  localStorage.setItem(ENCRYPTED_REFERENCE_KEY, encryptedRef[0]);
}

function getEncryptedKeyCreationTime() {
  let date = localStorage.getItem(ENCRYPTED_KEY_CREATION_TIME_KEY);
  return date ? new Date(Number(date)) : null;
}

function setEncryptedKeyCreationTime() {
  localStorage.setItem(ENCRYPTED_KEY_CREATION_TIME_KEY, Date.now().toString());
}

export async function setPasswordData(key: CryptoKey) {
  await setEncryptedReference(key);
  setEncryptedKeyCreationTime();
}

export function clearPasswordData() {
  localStorage.removeItem(ENCRYPTED_REFERENCE_KEY);
  localStorage.removeItem(ENCRYPTED_KEY_CREATION_TIME_KEY);
}

export function isPasswordExpired(): boolean {
  let time = getEncryptedKeyCreationTime();
  if(!time) {
    return true;
  }
  else {
    let expiryTime = new Date(time.getTime() + (TIME_ONE_HOUR * passwordExpiryHours));
    let currentTime = new Date(Date.now());
    return (currentTime > expiryTime);
  }
}

export async function isPasswordCorrect(password: string = ""): Promise<boolean> {
  let encryptedRefernce = getEncryptedReference();
  let tempKey = await generateCryptoKey(password);
  let result = await encryptData(referenceText, tempKey);
  return Promise.resolve(result[0] != encryptedRefernce);
}

async function getCryptoKey() {
  return encryptionKey.key;
}

export async function setCryptoKey(key: CryptoKey): Promise<CryptoKey>
export async function setCryptoKey(password: string): Promise<CryptoKey>
export async function setCryptoKey(input: CryptoKey | string): Promise<CryptoKey> {
  encryptionKey.key = (typeof input === "string") ? await generateCryptoKey(input) : input;
  return Promise.resolve(encryptionKey.key);
}

export async function encrypt(json: JSON) {
  let data = JSON.stringify(json);
  let key = await getCryptoKey();
  let encryptedData = await encryptData(data, key);
  return { 
    content: encryptedData[0],
    nonce: encryptedData[1]
  };
}

export async function decrypt(json: JSON) {
  let data = json[ENCRYPTION_CONTENT_KEY];
  let nonce = json[ENCRYPTION_NONCE_KEY];
  let key = await getCryptoKey();
  let decryptedData = await decryptData(data, key, nonce);
  return JSON.parse(decryptedData);
}

function getCryptoObject(): Crypto {
  return self.crypto; // for IE 11
}

function generateCryptoKey(input: string): Promise<CryptoKey> {
  let algorithm: string = 'AES-GCM';
  let keyUsages: KeyUsage[] = ['encrypt','decrypt'];
  let format: KeyFormat = 'raw';
  return Promise.resolve(
    getCryptoObject().subtle.importKey(
      format,
      encode(input),
      algorithm,
      false, // the original value will not be extractable
      keyUsages,
    )
  );
}

function encryptData(data: string, cryptoKey: CryptoKey): Promise<[string, string | null]> {
  let algorithm = { name: 'AES-GCM', iv: generateNonce() } as AesGcmParams;
  return Promise.resolve(
    getCryptoObject().subtle.encrypt(algorithm, cryptoKey, encode(data)),
  ).then(cryptoValue => [
    decode(cryptoValue),
    algorithm ? decode(algorithm.iv as Uint8Array, 8) : null,
  ]);
}

function decryptData(data: string, cryptoKey: CryptoKey, nonceOrAlgorithm: string): Promise<string> {
  const algorithm = { name: 'AES-GCM', iv: encode(nonceOrAlgorithm, 8) } as AesGcmParams;
  return Promise.resolve((getCryptoObject().subtle.decrypt(algorithm, cryptoKey, encode(data)))
    .then((buffer) => decode(buffer)));
}

function generateRandomValues(byteSize = 8): Uint8Array {
  return getCryptoObject().getRandomValues(new Uint8Array(byteSize));
}

function generateNonce(byteSize = 16): Uint8Array {
  // We should generate at least 16 bytes
  // to allow for 2^128 possible variations.
  return generateRandomValues(byteSize);
}

function encode(data: string, size: number = 16): ArrayBuffer {
  var arr = size == 8 ? new Uint8Array(data.length) : new Uint16Array(data.length);
  for (var i = data.length; i--; ) arr[i] = data.charCodeAt(i);
  return arr.buffer;
}

function decode(data: ArrayBuffer, size: number = 16): string {
  var arr = size == 8 ? new Uint8Array(data) : new Uint16Array(data);
  var str = String.fromCharCode.apply(String, arr);
  return str;
}