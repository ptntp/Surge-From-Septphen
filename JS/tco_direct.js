/**
 * t.co Direct for Surge
 *
 * 功能：
 * 1. 從 X / Twitter GraphQL 回應的 URL entities 建立：
 *      https://t.co/xxxx -> expanded_url
 *
 * 2. 將整份 GraphQL 回應中相同的 t.co 網址全部替換，
 *    包含：
 *      - 推文正文 url
 *      - 縮圖卡片 card_url
 *      - binding_values 裡的 string_value
 *      - 引用推文與其他相同短網址欄位
 *
 * 3. 不對整份回應使用 JSON.parse / JSON.stringify，
 *    避免大型 Tweet ID、User ID 發生 JavaScript 數字精度損失。
 */

(function () {
  const originalBody = $response.body;

  if (
    typeof originalBody !== "string" ||
    originalBody.length === 0
  ) {
    $done({});
    return;
  }

  // 沒有 expanded_url 或 t.co 就不必繼續處理
  if (
    originalBody.indexOf('"expanded_url"') === -1 ||
    originalBody.indexOf("t.co") === -1
  ) {
    $done({});
    return;
  }

  try {
    const urlMap = collectTcoUrlMap(originalBody);

    if (urlMap.size === 0) {
      console.log(
        "[t.co direct] 找不到可用的 t.co 與 expanded_url 對照"
      );

      $done({});
      return;
    }

    const result = rewriteMappedJsonStrings(
      originalBody,
      urlMap
    );

    if (result.replaced === 0) {
      console.log(
        "[t.co direct] 已建立 " +
          urlMap.size +
          " 組網址對照，但沒有需要替換的內容"
      );

      $done({});
      return;
    }

    const requestUrl =
      typeof $request !== "undefined" &&
      $request &&
      $request.url
        ? $request.url
        : "未知 GraphQL 請求";

    console.log(
      "[t.co direct] 成功建立 " +
        urlMap.size +
        " 組網址對照，共替換 " +
        result.replaced +
        " 個 t.co 網址：" +
        requestUrl
    );

    $done({
      body: result.body,
    });
  } catch (error) {
    console.log(
      "[t.co direct] 處理失敗：" +
        (
          error &&
          error.message
            ? error.message
            : String(error)
        )
    );

    // 發生錯誤時保留原始回應
    $done({});
  }
})();

/**
 * 將一段 JSON 字串內容解碼。
 *
 * 例如：
 *   https:\/\/t.co\/abc
 *
 * 會轉成：
 *   https://t.co/abc
 *
 * 只解析單一 JSON 字串，不解析整份 GraphQL 回應，
 * 因此不會影響大型數字 ID。
 */
function decodeJsonString(encoded) {
  try {
    return JSON.parse('"' + encoded + '"');
  } catch (_) {
    return null;
  }
}

/**
 * 掃描最內層 JSON Object，尋找同一個 URL entity 裡的：
 *
 *   "url": "https://t.co/..."
 *   "expanded_url": "https://example.com/..."
 *
 * 欄位不需要相鄰，也不限制排列順序。
 */
function collectTcoUrlMap(body) {
  const urlMap = new Map();
  const objectStack = [];

  let inString = false;
  let escaped = false;

  const expandedUrlRegex =
    /"expanded_url"\s*:\s*"((?:\\.|[^"\\])*)"/;

  const shortUrlRegex =
    /"url"\s*:\s*"((?:\\.|[^"\\])*)"/;

  for (let index = 0; index < body.length; index++) {
    const character = body[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }

      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === "{") {
      if (objectStack.length > 0) {
        objectStack[
          objectStack.length - 1
        ].hasChildObject = true;
      }

      objectStack.push({
        start: index,
        hasChildObject: false,
      });

      continue;
    }

    if (
      character !== "}" ||
      objectStack.length === 0
    ) {
      continue;
    }

    const currentObject = objectStack.pop();

    /*
     * URL entity 通常是最內層平面物件。
     * 父層可能同時包含多組 URL，不能直接取父層第一個
     * url 與第一個 expanded_url，否則可能配對錯誤。
     */
    if (currentObject.hasChildObject) {
      continue;
    }

    const objectText = body.slice(
      currentObject.start,
      index + 1
    );

    const expandedMatch =
      objectText.match(expandedUrlRegex);

    const shortMatch =
      objectText.match(shortUrlRegex);

    if (!expandedMatch || !shortMatch) {
      continue;
    }

    const shortUrl = decodeJsonString(
      shortMatch[1]
    );

    const expandedUrl = decodeJsonString(
      expandedMatch[1]
    );

    if (!shortUrl || !expandedUrl) {
      continue;
    }

    if (
      !/^https?:\/\/t\.co\//i.test(shortUrl)
    ) {
      continue;
    }

    // 避免把另一個 t.co 再當成展開網址
    if (
      /^https?:\/\/t\.co\//i.test(expandedUrl)
    ) {
      continue;
    }

    urlMap.set(shortUrl, expandedUrl);
  }

  return urlMap;
}

/**
 * 掃描整份回應裡的每一個 JSON 字串。
 *
 * 只要字串值完全等於已知的 t.co 短網址，就替換為
 * expanded_url。
 *
 * 因此可以同時處理：
 *
 *   "url": "https://t.co/..."
 *
 *   "card_url": "https://t.co/..."
 *
 *   "string_value": "https://t.co/..."
 */
function rewriteMappedJsonStrings(
  body,
  urlMap
) {
  let replacedCount = 0;

  const output = body.replace(
    /"((?:\\.|[^"\\])*)"/g,
    function (wholeMatch, encodedValue) {
      // 快速排除大部分無關 JSON 字串
      if (
        encodedValue.indexOf("t.co") === -1
      ) {
        return wholeMatch;
      }

      const decodedValue =
        decodeJsonString(encodedValue);

      if (!decodedValue) {
        return wholeMatch;
      }

      const expandedUrl =
        urlMap.get(decodedValue);

      if (!expandedUrl) {
        return wholeMatch;
      }

      replacedCount++;

      /*
       * JSON.stringify 單一字串可正確處理：
       * - 雙引號
       * - 反斜線
       * - 換行
       * - Unicode
       *
       * 這裡沒有解析或重新輸出整份 GraphQL JSON。
       */
      return JSON.stringify(expandedUrl);
    }
  );

  return {
    body: output,
    replaced: replacedCount,
  };
}
