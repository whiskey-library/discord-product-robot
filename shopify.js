import fetch from "node-fetch";
import FormData from "form-data";
import { Readable } from "stream";

const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

/**
 * Get a product by its numeric ID (or GID)
 * Returns product data with metafields for tasting card generation
 */
export async function getProductById(productId) {
  console.log("SHOPIFY: Fetching product by ID:", productId);

  // Normalize to GID if just numeric ID provided
  const gid = String(productId).startsWith("gid://")
    ? productId
    : `gid://shopify/Product/${productId}`;

  // Filter by namespace:"custom" so pagination only counts our metafields,
  // not app/theme/SEO metafields that could push ours past the `first` limit.
  const query = `
    query GetProduct($id: ID!) {
      product(id: $id) {
        id
        title
        handle
        descriptionHtml
        featuredImage {
          url
        }
        variants(first: 1) {
          edges {
            node {
              price
            }
          }
        }
        metafields(namespace: "custom", first: 50) {
          edges {
            node {
              namespace
              key
              value
            }
          }
        }
      }
    }
  `;

  const res = await fetch(
    `https://${SHOP}/admin/api/2024-10/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query, variables: { id: gid } })
    }
  );

  const data = await res.json();

  if (data.errors) {
    console.error("SHOPIFY: GraphQL errors:", data.errors);
    throw new Error(`Shopify GraphQL error: ${data.errors[0]?.message}`);
  }

  const product = data.data?.product;
  if (!product) {
    throw new Error(`Product not found: ${productId}`);
  }

  // Parse metafields into a flat object
  const metafields = {};
  for (const edge of product.metafields?.edges || []) {
    const node = edge.node;
    const fullKey = `${node.namespace}.${node.key}`;
    metafields[fullKey] = node.value;
  }

  const mfKeys = Object.keys(metafields);
  console.log(`SHOPIFY: Fetched ${mfKeys.length} metafields:`, mfKeys.join(", "));

  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    descriptionHtml: product.descriptionHtml,
    imageUrl: product.featuredImage?.url,
    price: product.variants?.edges?.[0]?.node?.price,
    metafields
  };
}

/**
 * Upload a file (PNG buffer) to Shopify Files via stagedUploadsCreate + fileCreate
 * Returns the MediaImage GID and CDN URL
 */
export async function uploadFileToShopify(pngBuffer, filename = "tasting-card.png") {
  console.log("SHOPIFY: Uploading file to Shopify Files:", filename, "size:", pngBuffer.length);

  // Step 1: Create staged upload target
  const stagedUploadMutation = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const stagedRes = await fetch(
    `https://${SHOP}/admin/api/2024-10/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: stagedUploadMutation,
        variables: {
          input: [{
            resource: "FILE",
            filename,
            mimeType: "image/png",
            httpMethod: "POST"
          }]
        }
      })
    }
  );

  const stagedData = await stagedRes.json();

  if (stagedData.errors || stagedData.data?.stagedUploadsCreate?.userErrors?.length > 0) {
    const errors = stagedData.errors || stagedData.data.stagedUploadsCreate.userErrors;
    console.error("SHOPIFY: Staged upload errors:", errors);
    
    // Check for ACCESS_DENIED error and provide helpful guidance
    const isAccessDenied = stagedData.errors?.some(e => e?.extensions?.code === "ACCESS_DENIED");
    if (isAccessDenied) {
      throw new Error(
        `Staged upload failed: ACCESS_DENIED. ` +
        `Your Shopify Admin API token is missing the 'write_files' scope. ` +
        `Go to Shopify Admin → Settings → Apps → Develop apps → Your App → Configuration → Admin API integration, ` +
        `add 'write_files' and 'read_files' scopes, save, and regenerate the API token.`
      );
    }
    
    throw new Error(`Staged upload failed: ${JSON.stringify(errors)}`);
  }

  const target = stagedData.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) {
    throw new Error("No staged upload target returned");
  }

  console.log("SHOPIFY: Staged upload URL:", target.url);

  // Step 2: Upload the file to the staged URL
  const formData = new FormData();
  for (const param of target.parameters) {
    formData.append(param.name, param.value);
  }
// #region agent log
  fetch('http://127.0.0.1:7242/ingest/5a136f99-0f58-49f0-8eb8-c368792b2230',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'shopify.js:uploadFileToShopify:step2',message:'Buffer type check before FormData append',data:{isBuffer:Buffer.isBuffer(pngBuffer),constructorName:pngBuffer?.constructor?.name,byteLength:pngBuffer?.length||pngBuffer?.byteLength||null,firstByte:pngBuffer?.[0]},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1-H2'})}).catch(()=>{});
  // #endregion

  // CRITICAL FIX: form-data requires a stream, not raw buffer.
  // Readable.from(buffer) iterates over bytes as numbers, so we must wrap in array.
  // Also ensure we have a proper Node.js Buffer, not Uint8Array.
  const safeBuffer = Buffer.isBuffer(pngBuffer) ? pngBuffer : Buffer.from(pngBuffer);
  const bufferStream = Readable.from([safeBuffer]);
  formData.append("file", bufferStream, {
    filename,
    contentType: "image/png",
    knownLength: safeBuffer.length
  });

  const uploadRes = await fetch(target.url, {
    method: "POST",
    body: formData,
    headers: formData.getHeaders()
  });

  if (!uploadRes.ok) {
    const uploadText = await uploadRes.text();
    console.error("SHOPIFY: File upload failed:", uploadRes.status, uploadText);
    throw new Error(`File upload failed: ${uploadRes.status}`);
  }

  console.log("SHOPIFY: File uploaded to staged URL");

  // Step 3: Create the file in Shopify
  const fileCreateMutation = `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          ... on MediaImage {
            id
            image {
              url
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const fileRes = await fetch(
    `https://${SHOP}/admin/api/2024-10/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: fileCreateMutation,
        variables: {
          files: [{
            contentType: "IMAGE",
            originalSource: target.resourceUrl
          }]
        }
      })
    }
  );

  const fileData = await fileRes.json();

  if (fileData.errors || fileData.data?.fileCreate?.userErrors?.length > 0) {
    const errors = fileData.errors || fileData.data.fileCreate.userErrors;
    console.error("SHOPIFY: File create errors:", errors);
    throw new Error(`File create failed: ${JSON.stringify(errors)}`);
  }

  const file = fileData.data?.fileCreate?.files?.[0];
  if (!file) {
    throw new Error("No file created");
  }

  console.log("SHOPIFY: File created:", file.id);

  return {
    id: file.id,
    url: file.image?.url
  };
}

/**
 * Set a metafield on a product
 * 
 * @param {string} productId - Product ID (numeric or GID)
 * @param {string} namespace - Metafield namespace (e.g., "custom")
 * @param {string} key - Metafield key
 * @param {string} value - Value to set
 * @param {string} type - Metafield type (default: "single_line_text_field")
 *                        Common types: "single_line_text_field", "file_reference", "number_integer"
 */
export async function setProductMetafield(productId, namespace, key, value, type = "single_line_text_field") {
  console.log("SHOPIFY: Setting metafield", `${namespace}.${key}`, "on product:", productId, "type:", type);

  // Normalize to GID if just numeric ID provided
  const productGid = String(productId).startsWith("gid://")
    ? productId
    : `gid://shopify/Product/${productId}`;

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          key
          value
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const res = await fetch(
    `https://${SHOP}/admin/api/2024-10/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          metafields: [{
            ownerId: productGid,
            namespace,
            key,
            value,
            type
          }]
        }
      })
    }
  );

  const data = await res.json();

  if (data.errors || data.data?.metafieldsSet?.userErrors?.length > 0) {
    const errors = data.errors || data.data.metafieldsSet.userErrors;
    console.error("SHOPIFY: Metafield set errors:", errors);
    throw new Error(`Metafield set failed: ${JSON.stringify(errors)}`);
  }

  console.log("SHOPIFY: Metafield set successfully");
  return data.data?.metafieldsSet?.metafields?.[0];
}

/**
 * Create a draft product with metafields
 * Uses a two-step process to ensure metafields are saved:
 * 1. Create product
 * 2. Update metafields via separate call
 */
export async function createDraftProduct(product) {
  console.log("SHOPIFY: Creating draft product");
  console.log("SHOPIFY PAYLOAD:", JSON.stringify(product, null, 2));

  // #region agent log
  (()=>{const payload={sessionId:'debug-session',runId:'pre-fix',hypothesisId:'H8',location:'shopify.js:16',message:'createDraftProduct entry',data:{incomingVendor:product?.vendor||null,incomingProductType:product?.product_type||null,metafieldsCount:Array.isArray(product?.metafields)?product.metafields.length:0,metafieldKeys:Array.isArray(product?.metafields)?product.metafields.map(m=>m.key).slice(0,30):[]},timestamp:Date.now()};console.log("AGENT_LOG",JSON.stringify(payload));globalThis.fetch?.('http://127.0.0.1:7242/ingest/5a136f99-0f58-49f0-8eb8-c368792b2230',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).catch(()=>{});})();
  // #endregion

  // Step 1: Create the product (without metafields to avoid type errors)
  const productData = await createProduct(product);
  
  if (!productData || !productData.id) {
    throw new Error("Shopify product creation failed");
  }

  console.log("SHOPIFY: Product created:", productData.id);

  // Step 2: Update metafields via GraphQL (more reliable)
  if (product.metafields && product.metafields.length > 0) {
    await updateMetafields(productData.id, product.metafields);
  }

  // Step 3: Publish to all sales channels
  await publishToAllChannels(productData.id);

  return productData;
}

/**
 * Create the base product
 */
async function createProduct(product) {
  const res = await fetch(
    `https://${SHOP}/admin/api/2024-10/products.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        product: {
          title: product.title,
          body_html: product.description,
          vendor: product.vendor || "The Whiskey Library",
          product_type: product.product_type || "",
          tags: Array.isArray(product.tags) ? product.tags.join(", ") : (product.tags || ""),
          status: "draft",
          published_scope: "global", // Publish to all channels
          variants: [
            {
              price: product.price,
              cost: product.cost,
              inventory_management: "shopify",
              inventory_policy: "deny",
              inventory_quantity: typeof product.quantity === "number" ? product.quantity : undefined,
              barcode: product.barcode ? String(product.barcode) : undefined,
              weight: 3.5,
              weight_unit: "lb",
              requires_shipping: true
            }
          ],
          images: (() => {
            if (!product.imageUrl) return [];
            // If we received a data URL (e.g., from OpenAI image edits), upload via base64 attachment.
            if (typeof product.imageUrl === "string" && product.imageUrl.startsWith("data:")) {
              const match = product.imageUrl.match(/^data:(.+?);base64,(.+)$/);
              const attachment = match?.[2];
              if (!attachment) return [];
              return [{ attachment, filename: "studio.png" }];
            }
            return [{ src: product.imageUrl }];
          })()
        }
      })
    }
  );

  const text = await res.text();
  console.log("SHOPIFY: Create product response:", text);

  if (!res.ok) {
    throw new Error(`Shopify API error (${res.status}): ${text}`);
  }

  const data = JSON.parse(text);
  
  if (!data.product || !data.product.id) {
    throw new Error("Shopify response missing product");
  }

  console.log("SHOPIFY: Vendor:", data.product.vendor);
  console.log("SHOPIFY: Product Type:", data.product.product_type);

  return data.product;
}

/**
 * Update metafields using GraphQL API (more reliable than REST)
 */
async function updateMetafields(productId, metafields) {
  console.log("SHOPIFY: Updating metafields for product", productId);
  console.log("SHOPIFY: Metafields to set:", metafields.length);

  // Convert product ID to GraphQL GID format
  const gid = `gid://shopify/Product/${productId}`;

  // Build metafields array for GraphQL
  const metafieldsInput = metafields.map(mf => ({
    namespace: mf.namespace || "custom",
    key: mf.key,
    value: mf.value,
    type: mf.type
  }));

  const mutation = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product {
          id
          metafields(first: 25) {
            edges {
              node {
                namespace
                key
                value
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    input: {
      id: gid,
      metafields: metafieldsInput
    }
  };

  try {
    const res = await fetch(
      `https://${SHOP}/admin/api/2024-10/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query: mutation, variables })
      }
    );

    const data = await res.json();
    console.log("SHOPIFY: GraphQL response:", JSON.stringify(data, null, 2));

    // #region agent log
    (()=>{const payload={sessionId:'debug-session',runId:'pre-fix',hypothesisId:'H9',location:'shopify.js:156',message:'updateMetafields result summary',data:{httpOk:res.ok,hasTopLevelErrors:Boolean(data?.errors?.length),userErrors:(data?.data?.productUpdate?.userErrors||[]).map(e=>({field:e.field?.join('.')||null,message:e.message})).slice(0,10),attemptedKeys:metafieldsInput.map(m=>m.key).slice(0,30)},timestamp:Date.now()};console.log("AGENT_LOG",JSON.stringify(payload));globalThis.fetch?.('http://127.0.0.1:7242/ingest/5a136f99-0f58-49f0-8eb8-c368792b2230',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).catch(()=>{});})();
    // #endregion

    if (data.errors) {
      console.error("SHOPIFY: GraphQL errors:", data.errors);
    }

    if (data.data?.productUpdate?.userErrors?.length > 0) {
      console.error("SHOPIFY: User errors:", data.data.productUpdate.userErrors);
      
      // Try setting metafields one by one to identify the problem
      console.log("SHOPIFY: Retrying metafields individually...");
      await updateMetafieldsIndividually(productId, metafields);
    } else {
      console.log("SHOPIFY: Metafields updated successfully");
      
      // Log which metafields were set
      const savedMetafields = data.data?.productUpdate?.product?.metafields?.edges || [];
      console.log("SHOPIFY: Saved metafields:", savedMetafields.length);
    }

  } catch (err) {
    console.error("SHOPIFY: Metafield update failed:", err.message);
    // Don't throw - product was still created
  }
}

/**
 * Try updating metafields one by one to identify issues
 */
async function updateMetafieldsIndividually(productId, metafields) {
  const gid = `gid://shopify/Product/${productId}`;
  let successCount = 0;

  for (const mf of metafields) {
    const mutation = `
      mutation productUpdate($input: ProductInput!) {
        productUpdate(input: $input) {
          product { id }
          userErrors { field message }
        }
      }
    `;

    const variables = {
      input: {
        id: gid,
        metafields: [{
          namespace: mf.namespace || "custom",
          key: mf.key,
          value: mf.value,
          type: mf.type
        }]
      }
    };

    try {
      const res = await fetch(
        `https://${SHOP}/admin/api/2024-10/graphql.json`,
        {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": TOKEN,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ query: mutation, variables })
        }
      );

      const data = await res.json();
      
      if (data.data?.productUpdate?.userErrors?.length > 0) {
        console.error(`SHOPIFY: Failed to set ${mf.key}:`, data.data.productUpdate.userErrors[0].message);
      } else {
        console.log(`SHOPIFY: Successfully set ${mf.key}`);
        successCount++;
      }

    } catch (err) {
      console.error(`SHOPIFY: Error setting ${mf.key}:`, err.message);
    }
  }

  console.log(`SHOPIFY: Set ${successCount}/${metafields.length} metafields individually`);
}

/**
 * Publish product to all sales channels
 * Requires read_publications and write_publications scopes on API token
 */
async function publishToAllChannels(productId) {
  console.log("SHOPIFY: Publishing to all sales channels");

  const gid = `gid://shopify/Product/${productId}`;

  // First, get all publication IDs
  const publicationsQuery = `
    query {
      publications(first: 20) {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  `;

  try {
    const pubRes = await fetch(
      `https://${SHOP}/admin/api/2024-10/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query: publicationsQuery })
      }
    );

    const pubData = await pubRes.json();
    
    // Check for GraphQL errors (usually indicates missing scopes)
    if (pubData.errors) {
      console.error("SHOPIFY: Publications query error:", JSON.stringify(pubData.errors));
      console.error("SHOPIFY: ⚠️  Make sure your API token has 'read_publications' scope!");
      return;
    }

    const publications = pubData.data?.publications?.edges || [];
    
    // Check if publications query returned empty
    if (publications.length === 0) {
      console.warn("SHOPIFY: ⚠️  No publications found!");
      console.warn("SHOPIFY: This usually means the API token is missing 'read_publications' scope.");
      console.warn("SHOPIFY: Add 'read_publications' and 'write_publications' scopes to your Shopify Admin API token.");
      return;
    }

    const channelNames = publications.map(p => p.node.name).join(", ");
    console.log("SHOPIFY: Found publications:", channelNames);

    // Publish to each channel
    let successCount = 0;
    for (const pub of publications) {
      const publishMutation = `
        mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $id, input: $input) {
            publishable {
              ... on Product {
                id
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      try {
        const publishRes = await fetch(
          `https://${SHOP}/admin/api/2024-10/graphql.json`,
          {
            method: "POST",
            headers: {
              "X-Shopify-Access-Token": TOKEN,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              query: publishMutation,
              variables: {
                id: gid,
                input: [{ publicationId: pub.node.id }]
              }
            })
          }
        );

        const publishData = await publishRes.json();
        
        if (publishData.errors) {
          console.error(`SHOPIFY: Failed to publish to ${pub.node.name}:`, publishData.errors[0]?.message);
        } else if (publishData.data?.publishablePublish?.userErrors?.length > 0) {
          console.error(`SHOPIFY: Failed to publish to ${pub.node.name}:`, 
            publishData.data.publishablePublish.userErrors[0].message);
        } else {
          console.log(`SHOPIFY: ✓ Published to ${pub.node.name}`);
          successCount++;
        }
      } catch (pubErr) {
        console.error(`SHOPIFY: Error publishing to ${pub.node.name}:`, pubErr.message);
      }
    }

    console.log(`SHOPIFY: Published to ${successCount}/${publications.length} channels`);

  } catch (err) {
    console.error("SHOPIFY: Failed to publish to channels:", err.message);
    // Don't throw - product was still created
  }
}
