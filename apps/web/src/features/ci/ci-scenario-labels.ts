type InverterInput = {
  dispatch_topology?: "shared_hybrid_dc" | "separate_ac";
  pv_inverter_capacity_kw_ac: number;
  battery_inverter_capacity_kw_ac?: number | null;
};

const capacity = (value: number) => String(value);

export function inverterDescription(input: InverterInput): string {
  if (input.dispatch_topology === "separate_ac") {
    return `${capacity(input.pv_inverter_capacity_kw_ac)} kW PV inverter · ${input.battery_inverter_capacity_kw_ac == null ? "Not recorded" : capacity(input.battery_inverter_capacity_kw_ac)} kW battery PCS`;
  }
  return `${capacity(input.pv_inverter_capacity_kw_ac)} kW hybrid inverter / PCS`;
}
