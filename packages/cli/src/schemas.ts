import Joi from "joi";

const refString = Joi.string().hex().length(72);

const tokenBaseSchema = Joi.object({
  // Reveal object isn't required in the bundle but can be used to prepopulate the generated reveal.json file
  // Why doesn't ...reveal.method work here?
  // R17: dmint batch-minting is intentionally not supported by the CLI;
  // the schema therefore exposes only `direct` and `psbt` reveal methods.
  // See `packages/lib/src/mint.ts:87` for the matching enforcement.
  reveal: Joi.when("$method", {
    switch: [
      {
        is: "direct",
        then: Joi.object({
          address: Joi.string(),
        }),
      },
      {
        is: "psbt",
        then: Joi.object({
          photons: Joi.number(),
          address: Joi.string(),
        }),
      },
    ],
    otherwise: Joi.forbidden(),
  }),
  name: Joi.string().when("$prepared", { is: true, then: Joi.required() }),
  type: Joi.string(),
  author: Joi.string(),
  license: Joi.string(),
  desc: Joi.string(),
  authorRefs: Joi.array().items(refString),
  containerRefs: Joi.array().items(refString),
  files: Joi.object().pattern(Joi.string(), [
    Joi.object({
      contentType: Joi.string(),
      src: Joi.string().required(),
      hash: [Joi.boolean(), Joi.string().hex()],
      stamp: Joi.boolean(),
    }),
    {
      contentType: Joi.string(),
      path: Joi.string(),
    },
  ]),
  attrs: Joi.object().pattern(Joi.string(), Joi.any()),
});

const nftSchema = tokenBaseSchema.append({
  contract: Joi.valid("nft").when("$prepared", {
    is: true,
    then: Joi.required(),
  }),
});

const ftSchema = tokenBaseSchema.append({
  contract: Joi.valid("ft").when("$prepared", {
    is: true,
    then: Joi.required(),
  }),
  ticker: Joi.string().when("$prepared", {
    is: true,
    then: Joi.required(),
  }),
  supply: Joi.number().positive().greater(0).when("$prepared", {
    is: true,
    then: Joi.required(),
  }),
});

export const bundleFileSchema = Joi.object({
  commit: Joi.object({ batchSize: Joi.number().required() }).required(),
  reveal: Joi.object({
    method: Joi.valid("direct", "psbt"),
    batchSize: Joi.when("method", {
      is: "direct",
      then: Joi.number(),
    }),
  }).required(),
  template: [nftSchema, ftSchema],
  tokens: Joi.array().items(nftSchema, ftSchema).min(1).required(),
});

export const revealFileSchema = Joi.object({
  method: Joi.valid("direct", "psbt").required(),
  batchSize: Joi.when("method", {
    is: "direct",
    then: Joi.number().required(),
  }),
  template: Joi.when("$method", {
    switch: [
      {
        is: "direct",
        then: Joi.object({
          address: Joi.string(),
        }),
      },
      {
        is: "psbt",
        then: Joi.object({
          photons: Joi.number(),
          address: Joi.string(),
        }),
      },
    ],
    otherwise: Joi.forbidden(),
  }),
  tokens: Joi.object()
    .pattern(
      refString,
      Joi.when("$method", {
        switch: [
          {
            is: "direct",
            then: Joi.object({
              address: Joi.string().required(),
            }),
          },
          {
            is: "psbt",
            then: Joi.object({
              photons: Joi.number().required(),
              address: Joi.string().required(),
            }),
          },
        ],
        otherwise: Joi.forbidden(),
      })
    )
    .required(),
});

export const walletFileSchema = Joi.object({
  ciphertext: Joi.string().required(),
  salt: Joi.string().required(),
  iv: Joi.string().required(),
  mac: Joi.string().required(),
  net: Joi.string().valid("mainnet", "testnet").required(),
  // Optional SLIP-0044 coin type. Legacy (pre-v3.0.0) wallets must set 0;
  // modern wallets may omit (defaults to 512).
  coinType: Joi.number().integer().min(0).optional(),
});

export const configFileSchema = Joi.object({
  mainnet: Joi.object({
    servers: Joi.array().items(Joi.string()),
  }),
  testnet: Joi.object({
    servers: Joi.array().items(Joi.string()),
  }),
});
