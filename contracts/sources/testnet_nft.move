module examples::testnet_nft;

use std::string;
use sui::event;
use sui::url::{Self, Url};
use sui::display;
use sui::object;
use sui::transfer;
use sui::tx_context::{Self, TxContext};
use sui::package;

// ==== One-Time Witness ====
public struct TESTNET_NFT has drop {}

// ==== NFT Structure ====
public struct TestnetNFT has key, store {
    id: object::UID,
    name: string::String,
    description: string::String,
    image_url: Url,
    thumbnail_url: Url,
}

// ==== Events ====
public struct NFTMinted has copy, drop {
    object_id: object::ID,
    creator: address,
    name: string::String,
}

// ==== Module Initializer ====
fun init(otw: TESTNET_NFT, ctx: &mut TxContext) {
    let publisher = package::claim(otw, ctx);
    let mut display = display::new<TestnetNFT>(&publisher, ctx);

    display::add(
        &mut display,
        string::utf8(b"name"),
        string::utf8(b"{name}")
    );
    
    display::add(
        &mut display,
        string::utf8(b"description"),
        string::utf8(b"{description}")
    );
    
    display::add(
        &mut display,
        string::utf8(b"image_url"),
        string::utf8(b"{image_url}")
    );
    
    display::add(
        &mut display,
        string::utf8(b"thumbnail_url"),
        string::utf8(b"{thumbnail_url}")
    );

    display::update_version(&mut display);
    
    transfer::public_transfer(publisher, tx_context::sender(ctx));
    transfer::public_transfer(display, tx_context::sender(ctx));
}

// ==== View Functions ====
public fun name(nft: &TestnetNFT): &string::String {
    &nft.name
}

public fun description(nft: &TestnetNFT): &string::String {
    &nft.description
}

public fun image_url(nft: &TestnetNFT): &Url {
    &nft.image_url
}

public fun thumbnail_url(nft: &TestnetNFT): &Url {
    &nft.thumbnail_url
}

// ==== Core Functions ====
#[allow(lint(self_transfer))]
public entry fun mint_to_sender(
    name: vector<u8>,
    description: vector<u8>,
    image_url: vector<u8>,
    thumbnail_url: vector<u8>,
    ctx: &mut TxContext,
) {
    let sender = tx_context::sender(ctx);
    let nft = TestnetNFT {
        id: object::new(ctx),
        name: string::utf8(name),
        description: string::utf8(description),
        image_url: url::new_unsafe_from_bytes(image_url),
        thumbnail_url: url::new_unsafe_from_bytes(thumbnail_url),
    };

    event::emit(NFTMinted {
        object_id: object::id(&nft),
        creator: sender,
        name: nft.name,
    });
    
    transfer::public_transfer(nft, sender);
}

public entry fun transfer(
    nft: TestnetNFT, 
    recipient: address, 
    ctx: &mut TxContext
) {
    transfer::public_transfer(nft, recipient);
}

public entry fun update_description(
    nft: &mut TestnetNFT,
    new_description: vector<u8>,
    _ctx: &mut TxContext,
) {
    nft.description = string::utf8(new_description);
}

public entry fun burn(nft: TestnetNFT, _ctx: &mut TxContext) {
    let TestnetNFT { 
        id,
        name: _,
        description: _,
        image_url: _,
        thumbnail_url: _
    } = nft;
    object::delete(id);
}