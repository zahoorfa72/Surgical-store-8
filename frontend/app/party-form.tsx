import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

import { apiRequest } from "@/src/api";
import { useParties, qk } from "@/src/data";
import { PartyType } from "@/src/models";
import { Field, PrimaryButton, ScreenHeader, useToast } from "@/src/ui";
import { makeStyles } from "@/src/theme";
import { useAuth } from "@/src/auth";
import { draftFieldSetter, usePersistentDraft } from "@/src/utils/use-persistent-draft";

export default function PartyForm() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const { id, type } = useLocalSearchParams<{ id?: string; type: PartyType }>();
  const partyType: PartyType = type === "supplier" ? "supplier" : "customer";
  const isSupplier = partyType === "supplier";
  const editing = !!id;

  const { data: parties } = useParties(partyType);
  const partyDraftInitial = useMemo(() => ({ name: "", phone: "", address: "" }), []);
  const partyDraftKey = `ssm.form-draft.party.v1.${user?.id ?? "device"}.${partyType}.${id ?? "new"}`;
  const [partyDraft, setPartyDraft, draftReady, draftRestored, clearPartyDraft] =
    usePersistentDraft(partyDraftKey, partyDraftInitial);
  const { name, phone, address } = partyDraft;
  const setName = draftFieldSetter(setPartyDraft, "name");
  const setPhone = draftFieldSetter(setPartyDraft, "phone");
  const setAddress = draftFieldSetter(setPartyDraft, "address");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (id && parties && draftReady && !draftRestored) {
      const p = parties.find((x) => x.id === id);
      if (p) {
        setName(p.name);
        setPhone(p.phone);
        setAddress(p.address);
      }
    }
  }, [id, parties, draftReady, draftRestored]);

  const save = async () => {
    if (!name.trim()) {
      toast("Enter a name", "error");
      return;
    }
    setBusy(true);
    const body = { name: name.trim(), type: partyType, phone: phone.trim(), address: address.trim() };
    try {
      if (editing) await apiRequest(`/parties/${id}`, { method: "PUT", body });
      else await apiRequest("/parties", { method: "POST", body });
      await queryClient.invalidateQueries({ queryKey: qk.parties(partyType) });
      await clearPartyDraft();
      toast("Saved", "success");
      router.back();
    } catch (e: any) {
      toast(e?.message || "Save failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const label = isSupplier ? "supplier" : "customer";

  return (
    <View style={styles.root}>
      <ScreenHeader
        title={editing ? `Edit ${label}` : `New ${label}`}
        topInset={insets.top}
        onBack={() => router.back()}
      />
      <KeyboardAwareScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 16 }} bottomOffset={20}>
        <Field label="Name" testID="party-name-input" value={name} onChangeText={setName} placeholder={isSupplier ? "e.g. MedSupply Co." : "e.g. City Clinic"} />
        <Field label="Phone" testID="party-phone-input" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="Optional" />
        <Field label="Address" testID="party-address-input" value={address} onChangeText={setAddress} placeholder="Optional" multiline />
        <PrimaryButton label={editing ? "Save changes" : `Add ${label}`} onPress={save} busy={busy} testID="save-party-button" />
      </KeyboardAwareScrollView>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
}));
