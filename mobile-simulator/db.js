const DATABASE_NAME = "sticks3-mobile-simulator";
const DATABASE_VERSION = 1;

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("transaction aborted"));
  });
}

export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("recordings")) {
        const store = database.createObjectStore("recordings", { keyPath: "event_id" });
        store.createIndex("created_at", "created_at");
      }
      if (!database.objectStoreNames.contains("cloud")) {
        const store = database.createObjectStore("cloud", { keyPath: "event_id" });
        store.createIndex("created_at", "created_at");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function put(storeName, value) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put(value);
  await transactionDone(transaction);
  database.close();
  return value;
}

async function get(storeName, key) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readonly");
  const value = await requestAsPromise(transaction.objectStore(storeName).get(key));
  await transactionDone(transaction);
  database.close();
  return value;
}

async function getAll(storeName) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readonly");
  const values = await requestAsPromise(transaction.objectStore(storeName).getAll());
  await transactionDone(transaction);
  database.close();
  return values.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function remove(storeName, key) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).delete(key);
  await transactionDone(transaction);
  database.close();
}

export const recordings = {
  put: (value) => put("recordings", value),
  getAll: () => getAll("recordings"),
  delete: (key) => remove("recordings", key),
};

export const cloudRecords = {
  put: (value) => put("cloud", value),
  get: (key) => get("cloud", key),
  getAll: () => getAll("cloud"),
};
