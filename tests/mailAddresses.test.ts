import { describe, expect, it } from "vitest";
import { senderFor, toMailAddresses } from "../src/utils/mailAddresses.js";

describe("mailAddresses", () => {
  describe("senderFor", () => {
    it("should use the account as address", () => {
      expect(senderFor("john.doe@example.com").address).toBe(
        "john.doe@example.com",
      );
    });

    it("should derive a capitalised name from the local part", () => {
      expect(senderFor("john.doe@example.com").name).toBe("John Doe");
      expect(senderFor("anna-lena_meier@example.com").name).toBe(
        "Anna Lena Meier",
      );
    });

    it("should not leave extra spaces when separators repeat or lead", () => {
      expect(senderFor("john..doe@example.com").name).toBe("John Doe");
      expect(senderFor("_info@example.com").name).toBe("Info");
      expect(senderFor("info-@example.com").name).toBe("Info");
    });
  });

  describe("toMailAddresses", () => {
    it("should keep name and address as objects", () => {
      expect(
        toMailAddresses([{ name: "Jörg Müller", address: "j@example.com" }]),
      ).toEqual([{ name: "Jörg Müller", address: "j@example.com" }]);
    });

    it("should default a missing name to an empty string", () => {
      expect(toMailAddresses([{ address: "j@example.com" }])).toEqual([
        { name: "", address: "j@example.com" },
      ]);
    });

    it("should handle an empty list", () => {
      expect(toMailAddresses([])).toEqual([]);
    });
  });
});
